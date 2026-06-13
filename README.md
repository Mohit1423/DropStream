# DropStream 🚀

DropStream is a fast, secure, and decentralized peer-to-peer (P2P) file-sharing web application. It allows users to transfer files directly between browsers using WebRTC, without any intermediate servers storing or intercepting the data.

**Live Deployment:** [https://drop-stream.vercel.app/](https://drop-stream.vercel.app/)

## ✨ Key Features

- **Direct P2P File Transfer**: Files are transferred securely browser-to-browser via WebRTC Data Channels.
- **Unlimited File Sizes (OPFS)**: Utilizing the Origin Private File System (OPFS), DropStream writes incoming chunks directly to local storage, entirely bypassing standard browser RAM limitations. Transfer multi-gigabyte files without crashing your browser!
- **Cryptographic File Verification**: Zero data corruption. Files are hashed using native SHA-256 before transmission. Once received, the downloaded file is re-hashed and verified to ensure exact parity with the sender.
- **Real-Time Progress Stats**: Beautiful UI showing live transfer percentage and precise network speeds (MB/s).
- **Socket.io Signaling**: Fast, lightweight Node.js backend solely used to negotiate the initial connection handshakes between peers.

## 🛠️ Technology Stack

- **Frontend**: React 18, Vite, TypeScript, TailwindCSS v4, Lucide React Icons
- **Backend**: Node.js, Express, Socket.io, TypeScript
- **Core APIs**: WebRTC, Web Crypto API, Streams API, OPFS (`navigator.storage`)

## 💻 Local Setup

Because the application uses a decoupled architecture, you must run both the frontend and backend servers.

### 1. Start the Signaling Backend

```bash
cd backend
npm install
npm run dev
```
*The signaling server will start on `http://localhost:3001`.*

### 2. Start the Frontend
In a new terminal window:
```bash
cd frontend
npm install
npm run dev
```
*The React app will start on `http://localhost:5173`.*

## 🌐 Architecture Overview

1. **Room Creation**: The Sender selects a file and a unique room ID is generated.
2. **Handshake**: The Receiver opens the link. The Node.js signaling server brokers WebRTC SDP Offers, Answers, and ICE Candidates between the two peers.
3. **P2P Connection**: A secure WebRTC connection is established. The signaling server's job is complete and it drops out of the equation.
4. **Data Stream**: The Sender's browser reads the file as an `ArrayBuffer` and streams it over the `RTCDataChannel`. The Receiver's browser catches the stream and pipes it directly to disk via OPFS.


