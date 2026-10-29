import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('vendor', { recursive: true });
await copyFile('node_modules/socket.io-client/dist/socket.io.min.js', 'vendor/socket.io.min.js');
await copyFile('node_modules/socket.io-client/LICENSE', 'vendor/socket.io.LICENSE');
console.log('Bundled Socket.IO locally. Load this extension directory in Chrome.');
