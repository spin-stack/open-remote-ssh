package main

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"io"
	"strings"
	"testing"
	"testing/fstest"
)

const packageJSON = `{
	"name": "spinbox-remote",
	"displayName": "Spinbox Remote",
	"description": "Opens the spin+<workspace> remote & more.",
	"version": "2.1.0",
	"publisher": "spin-stack",
	"main": "./lib/extension.js",
	"icon": "resources/icon.png",
	"engines": { "vscode": "^1.146.0" },
	"enabledApiProposals": ["resolvers"],
	"extensionKind": ["ui"],
	"keywords": ["remote", "spinbox"],
	"categories": ["Other"]
}`

func checkout() fstest.MapFS {
	return fstest.MapFS{
		"package.json":       {Data: []byte(packageJSON)},
		"LICENSE.txt":        {Data: []byte("MIT")},
		"README.md":          {Data: []byte("# Spinbox Remote")},
		"lib/extension.js":   {Data: []byte("exports.activate = () => {}")},
		"resources/icon.png": {Data: []byte("\x89PNG")},
		"src/extension.ts":   {Data: []byte("export {}")},
	}
}

var files = []string{"package.json", "LICENSE.txt", "README.md", "lib/extension.js", "resources/icon.png"}

func entries(t *testing.T, vsix []byte) (*zip.Reader, []string) {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(vsix), int64(len(vsix)))
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, f := range zr.File {
		names = append(names, f.Name)
	}
	return zr, names
}

func entry(t *testing.T, zr *zip.Reader, name string) []byte {
	t.Helper()
	f, err := zr.Open(name)
	if err != nil {
		t.Fatal(err)
	}
	b, err := io.ReadAll(f)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestPackLaysOutWhatVSCodeInstalls(t *testing.T) {
	vsix, err := pack(checkout(), files)
	if err != nil {
		t.Fatal(err)
	}
	zr, names := entries(t, vsix)
	want := []string{
		"extension.vsixmanifest",
		"[Content_Types].xml",
		"extension/LICENSE.txt",
		"extension/readme.md",
		"extension/lib/extension.js",
		"extension/package.json",
		"extension/resources/icon.png",
	}
	if strings.Join(names, " ") != strings.Join(want, " ") {
		t.Fatalf("entries:\n got %v\nwant %v", names, want)
	}
	for _, f := range zr.File {
		if !f.Modified.Equal(epoch) {
			t.Errorf("%s: modified %v, want %v", f.Name, f.Modified, epoch)
		}
	}
	if got := string(entry(t, zr, "extension/package.json")); got != packageJSON {
		t.Errorf("package.json changed in the package: %q", got)
	}

	var m struct {
		Metadata struct {
			Identity struct {
				ID        string `xml:"Id,attr"`
				Version   string `xml:"Version,attr"`
				Publisher string `xml:"Publisher,attr"`
			}
			Description string
			Properties  struct {
				Property []struct {
					ID    string `xml:"Id,attr"`
					Value string `xml:",attr"`
				}
			}
			License string
			Icon    string
		}
		Assets struct {
			Asset []struct {
				Type string `xml:",attr"`
				Path string `xml:",attr"`
			}
		}
	}
	if err := xml.Unmarshal(entry(t, zr, "extension.vsixmanifest"), &m); err != nil {
		t.Fatalf("the manifest is not XML: %v", err)
	}
	id := m.Metadata.Identity
	if id.ID != "spinbox-remote" || id.Version != "2.1.0" || id.Publisher != "spin-stack" {
		t.Errorf("identity: %+v", id)
	}
	if m.Metadata.Description != "Opens the spin+<workspace> remote & more." {
		t.Errorf("description: %q", m.Metadata.Description)
	}
	props := map[string]string{}
	for _, p := range m.Metadata.Properties.Property {
		props[p.ID] = p.Value
	}
	for k, v := range map[string]string{
		"Microsoft.VisualStudio.Code.Engine":              "^1.146.0",
		"Microsoft.VisualStudio.Code.EnabledApiProposals": "resolvers",
		"Microsoft.VisualStudio.Code.ExtensionKind":       "ui",
		"Microsoft.VisualStudio.Code.ExecutesCode":        "true",
	} {
		if props[k] != v {
			t.Errorf("%s = %q, want %q", k, props[k], v)
		}
	}
	if m.Metadata.License != "extension/LICENSE.txt" || m.Metadata.Icon != "extension/resources/icon.png" {
		t.Errorf("license %q, icon %q", m.Metadata.License, m.Metadata.Icon)
	}
	for _, a := range m.Assets.Asset {
		if _, err := zr.Open(a.Path); err != nil {
			t.Errorf("asset %s names %s, which the package does not hold", a.Type, a.Path)
		}
	}
	types := string(entry(t, zr, "[Content_Types].xml"))
	for _, ext := range []string{".js", ".json", ".md", ".png", ".txt", ".vsixmanifest"} {
		if !strings.Contains(types, `Extension="`+ext+`"`) {
			t.Errorf("[Content_Types].xml has no %s: %s", ext, types)
		}
	}
}

// spin pins the release's digest: the same files make the same bytes, whatever order they are
// named in.
func TestPackIsTheSameBytesForTheSameFiles(t *testing.T) {
	a, err := pack(checkout(), files)
	if err != nil {
		t.Fatal(err)
	}
	b, err := pack(checkout(), []string{"package.json", "resources/icon.png", "lib/extension.js", "README.md", "LICENSE.txt"})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(a, b) {
		t.Error("two packages of the same files differ")
	}
}

func TestPackRefuses(t *testing.T) {
	without := func(name string) fstest.MapFS {
		c := checkout()
		delete(c, name)
		return c
	}
	for _, tc := range []struct {
		name  string
		root  fstest.MapFS
		files []string
		want  string
	}{
		{"package.json not first", checkout(), []string{"LICENSE.txt", "package.json"}, "must be the first"},
		{"a file that is not there", without("README.md"), files, "README.md"},
		{"a kind with no content type", checkout(), append([]string{"package.json", "src/extension.ts"}, files[1:]...), `".ts"`},
		{"a path out of the checkout", checkout(), append(files, "../secret.txt"), "path from the checkout's root"},
		{"main not packaged", checkout(), []string{"package.json", "LICENSE.txt", "resources/icon.png"}, "lib/extension.js"},
		{"icon not packaged", checkout(), []string{"package.json", "LICENSE.txt", "lib/extension.js"}, "resources/icon.png"},
		{"no license", checkout(), []string{"package.json", "lib/extension.js", "resources/icon.png"}, "no LICENSE"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := pack(tc.root, tc.files)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want one naming %s", err, tc.want)
			}
		})
	}
}
