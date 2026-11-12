// The ssh2 connection to a workspace's sshd, over the stream `spin ssh-proxy` carries, and the
// local port VS Code reaches the workspace's server through. It began as
// sanketbajoria/ssh2-promise's SSHConnection, by way of jeanp413/open-remote-ssh.

import * as net from 'net';
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';

export default class SSHConnection {
    private readonly client = new Client();
    private ready: Promise<void> | undefined;
    private readonly servers: net.Server[] = [];

    constructor(private readonly config: ConnectConfig) { }

    connect(): Promise<void> {
        this.ready ??= new Promise((resolve, reject) => {
            this.client
                .on('ready', () => resolve())
                .on('error', reject)
                // ssh2 says an error before it closes: a close with none is a peer that hung up.
                .on('close', () => reject(new Error('the workspace closed the connection before it was ready')))
                .connect(this.config);
        });
        return this.ready;
    }

    async exec(command: string): Promise<{ stdout: string; stderr: string }> {
        await this.connect();
        return new Promise((resolve, reject) => {
            this.client.exec(command, (err, stream) => {
                if (err) {
                    return reject(err);
                }
                let stdout = '';
                let stderr = '';
                stream.on('close', () => resolve({ stdout, stderr }))
                    .on('data', (d: Buffer) => { stdout += d.toString(); })
                    .stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
            });
        });
    }

    async forwardOut(srcIP: string, srcPort: number, destIP: string, destPort: number): Promise<ClientChannel> {
        await this.connect();
        return new Promise((resolve, reject) => {
            this.client.forwardOut(srcIP, srcPort, destIP, destPort, (err, stream) => err ? reject(err) : resolve(stream));
        });
    }

    /**
     * A port on this machine's loopback, chosen by the system, whose every connection is carried
     * to remotePort on the workspace's loopback. Only this machine reaches it.
     */
    async forwardLocal(remotePort: number): Promise<number> {
        await this.connect();
        const server = net.createServer(socket => {
            this.forwardOut('127.0.0.1', 0, '127.0.0.1', remotePort).then(stream => {
                // An 'error' on either end left unhandled would end the extension host: the
                // other end is destroyed instead.
                stream.on('error', () => socket.destroy());
                socket.on('error', () => stream.destroy());
                stream.pipe(socket);
                socket.pipe(stream);
            }, () => socket.destroy());
        });
        this.servers.push(server);
        return new Promise((resolve, reject) => {
            server.once('error', reject).listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
        });
    }

    async close(): Promise<void> {
        await Promise.all(this.servers.splice(0).map(s => new Promise<void>(resolve => s.close(() => resolve()))));
        this.client.end();
    }
}
