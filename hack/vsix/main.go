// Command vsix packages the extension into a VSIX: the files it is given under extension/, the
// manifest VS Code installs it by, and the content types the zip's Open Packaging Conventions
// require.
//
//	go run ./hack/vsix -out spinbox-remote.vsix package.json LICENSE.txt README.md lib/extension.js resources/icon.png
//
// It stands where vsce stood. vsce brought a few hundred npm packages for what this extension needs
// of it - a zip of five files and an XML manifest - because the Marketplace, which is the rest of
// vsce, refuses an extension that uses a proposed API, so a release is a GitHub release. The zip
// is the same bytes for the same files: entries in a fixed order, each with one fixed time, so a
// release's digest, which spin pins, can be made again from its tag.
package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"encoding/xml"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"path"
	"slices"
	"strings"
	"text/template"
	"time"
)

func main() {
	out := flag.String("out", "", "the VSIX to write")
	flag.Parse()
	if *out == "" || flag.NArg() == 0 {
		fmt.Fprintln(os.Stderr, "usage: vsix -out <file.vsix> package.json <file>...")
		os.Exit(2)
	}
	if err := write(*out, os.DirFS("."), flag.Args()); err != nil {
		fmt.Fprintf(os.Stderr, "vsix: %v\n", err)
		os.Exit(1)
	}
}

func write(out string, root fs.FS, files []string) error {
	data, err := pack(root, files)
	if err != nil {
		return err
	}
	return os.WriteFile(out, data, 0o644)
}

// Every entry's time: the earliest a zip can hold, so the time a file was built at does not reach
// the digest.
var epoch = time.Date(1980, 1, 1, 0, 0, 0, 0, time.UTC)

// The types the zip's [Content_Types].xml names, by extension. A file of any other kind is refused
// rather than given a guess VS Code might not serve.
var contentTypes = map[string]string{
	".js":           "application/javascript",
	".json":         "application/json",
	".md":           "text/markdown",
	".png":          "image/png",
	".txt":          "text/plain",
	".vsixmanifest": "text/xml",
}

type manifest struct {
	Name                string   `json:"name"`
	DisplayName         string   `json:"displayName"`
	Description         string   `json:"description"`
	Version             string   `json:"version"`
	Publisher           string   `json:"publisher"`
	Main                string   `json:"main"`
	Icon                string   `json:"icon"`
	Categories          []string `json:"categories"`
	Keywords            []string `json:"keywords"`
	EnabledAPIProposals []string `json:"enabledApiProposals"`
	ExtensionKind       []string `json:"extensionKind"`
	Engines             struct {
		VSCode string `json:"vscode"`
	} `json:"engines"`
	Repository struct {
		URL string `json:"url"`
	} `json:"repository"`
	Bugs struct {
		URL string `json:"url"`
	} `json:"bugs"`
}

// The package's own files, under extension/, as VS Code finds them: the README is readme.md
// whatever its case, as vsce names it.
func entryName(file string) string {
	if strings.EqualFold(file, "README.md") {
		return "extension/readme.md"
	}
	return "extension/" + file
}

func pack(root fs.FS, files []string) ([]byte, error) {
	if files[0] != "package.json" {
		return nil, errors.New("package.json must be the first file: the manifest is made from it")
	}
	contents := make(map[string][]byte, len(files))
	for _, f := range files {
		if path.Clean(f) != f || path.IsAbs(f) || strings.HasPrefix(f, "../") {
			return nil, fmt.Errorf("%s: a file is named by its path from the checkout's root", f)
		}
		if _, ok := contentTypes[path.Ext(f)]; !ok {
			return nil, fmt.Errorf("%s: no content type for %q files", f, path.Ext(f))
		}
		b, err := fs.ReadFile(root, f)
		if err != nil {
			return nil, err
		}
		contents[f] = b
	}
	var m manifest
	if err := json.Unmarshal(contents["package.json"], &m); err != nil {
		return nil, fmt.Errorf("package.json: %w", err)
	}
	if m.Name == "" || m.Publisher == "" || m.Version == "" || m.Engines.VSCode == "" {
		return nil, errors.New("package.json: name, publisher, version and engines.vscode are what VS Code installs by")
	}
	for _, want := range []string{mainFile(m.Main), m.Icon} {
		if want != "" && !slices.Contains(files, want) {
			return nil, fmt.Errorf("package.json names %s, which is not among the files", want)
		}
	}
	license := ""
	for _, f := range files {
		if strings.HasPrefix(strings.ToUpper(path.Base(f)), "LICENSE") {
			license = f
		}
	}
	if license == "" {
		return nil, errors.New("no LICENSE among the files")
	}

	vsixmanifest, err := renderManifest(m, files, license)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	add := func(name string, b []byte) error {
		w, err := zw.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Deflate, Modified: epoch})
		if err != nil {
			return err
		}
		_, err = w.Write(b)
		return err
	}
	if err := add("extension.vsixmanifest", vsixmanifest); err != nil {
		return nil, err
	}
	if err := add("[Content_Types].xml", renderContentTypes(files)); err != nil {
		return nil, err
	}
	sorted := slices.Clone(files)
	slices.Sort(sorted)
	for _, f := range sorted {
		if err := add(entryName(f), contents[f]); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// The file package.json's main names, as VS Code resolves it: .js when it has no extension.
func mainFile(main string) string {
	if main == "" {
		return ""
	}
	f := path.Clean(main)
	if path.Ext(f) == "" {
		f += ".js"
	}
	return f
}

func renderContentTypes(files []string) []byte {
	exts := []string{".vsixmanifest"}
	for _, f := range files {
		if e := path.Ext(f); !slices.Contains(exts, e) {
			exts = append(exts, e)
		}
	}
	slices.Sort(exts)
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="utf-8"?>` + "\n")
	b.WriteString(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`)
	for _, e := range exts {
		fmt.Fprintf(&b, `<Default Extension="%s" ContentType="%s"/>`, e, contentTypes[e])
	}
	b.WriteString("</Types>")
	return []byte(b.String())
}

var manifestTemplate = template.Must(template.New("vsixmanifest").Funcs(template.FuncMap{
	"x":    escape,
	"join": func(s []string) string { return escape(strings.Join(s, ",")) },
}).Parse(`<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
	<Metadata>
		<Identity Language="en-US" Id="{{x .M.Name}}" Version="{{x .M.Version}}" Publisher="{{x .M.Publisher}}" />
		<DisplayName>{{x .M.DisplayName}}</DisplayName>
		<Description xml:space="preserve">{{x .M.Description}}</Description>
		<Tags>{{join .M.Keywords}}</Tags>
		<Categories>{{join .M.Categories}}</Categories>
		<GalleryFlags>Public</GalleryFlags>
		<Properties>
			<Property Id="Microsoft.VisualStudio.Code.Engine" Value="{{x .M.Engines.VSCode}}" />
			<Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
			<Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
			<Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="{{join .M.ExtensionKind}}" />
			<Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
			<Property Id="Microsoft.VisualStudio.Code.EnabledApiProposals" Value="{{join .M.EnabledAPIProposals}}" />
			<Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="{{if .M.Main}}true{{else}}false{{end}}" />
{{- with .M.Repository.URL}}
			<Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="{{x .}}" />
{{- end}}
{{- with .M.Bugs.URL}}
			<Property Id="Microsoft.VisualStudio.Services.Links.Support" Value="{{x .}}" />
{{- end}}
			<Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
			<Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free" />
		</Properties>
		<License>{{x .License}}</License>
{{- with .M.Icon}}
		<Icon>extension/{{x .}}</Icon>
{{- end}}
	</Metadata>
	<Installation>
		<InstallationTarget Id="Microsoft.VisualStudio.Code" />
	</Installation>
	<Dependencies />
	<Assets>
		<Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
{{- with .Readme}}
		<Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="{{x .}}" Addressable="true" />
{{- end}}
		<Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="{{x .License}}" Addressable="true" />
{{- with .M.Icon}}
		<Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/{{x .}}" Addressable="true" />
{{- end}}
	</Assets>
</PackageManifest>
`))

func renderManifest(m manifest, files []string, license string) ([]byte, error) {
	readme := ""
	for _, f := range files {
		if strings.EqualFold(f, "README.md") {
			readme = entryName(f)
		}
	}
	var b bytes.Buffer
	err := manifestTemplate.Execute(&b, struct {
		M       manifest
		License string
		Readme  string
	}{m, entryName(license), readme})
	return b.Bytes(), err
}

func escape(s string) string {
	var b strings.Builder
	_ = xml.EscapeText(&b, []byte(s)) // a strings.Builder does not fail a write
	return b.String()
}
