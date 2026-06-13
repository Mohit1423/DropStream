import { useEffect, useState, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { UploadCloud, Link as LinkIcon, CheckCircle2, AlertCircle, Download, Loader2, File as FileIcon } from 'lucide-react';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3001';
const CHUNK_SIZE = 64 * 1024; 

export default function App() {
  const [roomId] = useState<string>(() => {
    const roomParam = new URLSearchParams(window.location.search).get('room');
    return roomParam || Math.random().toString(36).substring(2, 9);
  });
  const [isSender] = useState<boolean>(() => !new URLSearchParams(window.location.search).get('room'));
  
  const [status, setStatus] = useState<string>(isSender ? 'Waiting for peer to join...' : 'Connecting to peer...');
  const [progress, setProgress] = useState<number>(0);
  const [transferSpeed, setTransferSpeed] = useState<string>('0');
  const [fileInfo, setFileInfo] = useState<{ name: string, size: number, hash?: string } | null>(null);
  const fileInfoRef = useRef<{ name: string, size: number, hash?: string } | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  
  const socketRef = useRef<Socket | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  
  const fileRef = useRef<File | null>(null);
  const offsetRef = useRef<number>(0);
  
  const receivedSizeRef = useRef<number>(0);
  const fileStreamRef = useRef<FileSystemWritableFileStream | null>(null);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());

  const lastTimeRef = useRef<number>(Date.now());
  const lastBytesRef = useRef<number>(0);

  useEffect(() => {

    const socket = io(SOCKET_URL);
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('Connected to signaling server');
      socket.emit('join-room', roomId);
    });

    socket.on('peer-joined', async () => {
      console.log('Peer joined. Initiating WebRTC connection...');
      setStatus('Peer joined. Negotiating connection...');
      if (isSender) {
        initiateWebRTC(true);
      }
    });

    socket.on('offer', async (data) => {
      console.log('Received offer');
      if (!isSender) {
        await initiateWebRTC(false);
        await peerConnectionRef.current?.setRemoteDescription(new RTCSessionDescription(data.offer));
        const answer = await peerConnectionRef.current?.createAnswer();
        await peerConnectionRef.current?.setLocalDescription(answer);
        socket.emit('answer', { answer, roomId });
      }
    });

    socket.on('answer', async (data) => {
      console.log('Received answer');
      if (isSender) {
        await peerConnectionRef.current?.setRemoteDescription(new RTCSessionDescription(data.answer));
      }
    });

    socket.on('ice-candidate', async (data) => {
      if (peerConnectionRef.current && data.candidate) {
        try {
          await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (e) {
          console.error('Error adding ICE candidate', e);
        }
      }
    });

    socket.on('peer-disconnected', () => {
      setStatus('Peer disconnected.');
      cleanupWebRTC();
    });

    socket.on('room-full', () => {
      setStatus('Room is full. Only 1-to-1 transfers are supported.');
      socket.disconnect();
    });

    return () => {
      socket.disconnect();
      cleanupWebRTC();
    };
  }, []);

  const cleanupWebRTC = () => {
    if (dataChannelRef.current) dataChannelRef.current.close();
    if (peerConnectionRef.current) peerConnectionRef.current.close();
    dataChannelRef.current = null;
    peerConnectionRef.current = null;
  };

  const initiateWebRTC = async (initiator: boolean) => {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    peerConnectionRef.current = pc;

    pc.onicecandidate = (event) => {
      if (event.candidate && socketRef.current) {
        socketRef.current.emit('ice-candidate', {
          candidate: event.candidate,
          roomId
        });
      }
    };

    if (initiator) {
      const dc = pc.createDataChannel('file-transfer', { ordered: true });
      setupDataChannel(dc);
      
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socketRef.current?.emit('offer', { offer, roomId });
    } else {
      pc.ondatachannel = (event) => {
        setupDataChannel(event.channel);
      };
    }
  };

  const setupDataChannel = (dc: RTCDataChannel) => {
    dataChannelRef.current = dc;
    dc.binaryType = 'arraybuffer';

    dc.onopen = () => {
      console.log('Data channel open');
      setStatus('Connected. Ready for transfer.');
      if (!isSender) {
        setStatus('Waiting for file transfer to start...');
      } else if (fileRef.current) {
        startTransfer();
      }
    };

    dc.onclose = () => {
      console.log('Data channel closed');
    };

    dc.onmessage = async (event) => {
      if (typeof event.data === 'string') {
        try {
          const meta = JSON.parse(event.data);
          if (meta.type === 'metadata') {
            const newMeta = { name: meta.name, size: meta.size, hash: meta.hash };
            setFileInfo(newMeta);
            fileInfoRef.current = newMeta;
            setDownloadUrl(null); 
            setStatus(`Receiving ${meta.name}...`);
            receivedSizeRef.current = 0;
            setProgress(0);
            
            (async () => {
              try {
                const root = await navigator.storage.getDirectory();
                const fileHandle = await root.getFileHandle('dropstream_temp', { create: true });
                fileStreamRef.current = await fileHandle.createWritable();
              } catch (e) {
                console.error("OPFS init failed", e);
                setStatus('Failed to initialize local storage for download.');
              }
            })();
          } else if (meta.type === 'done') {
            handleDownload();
          }
        } catch(e) {}
      } else {
        const chunk = new Uint8Array(event.data);
        
        writeQueueRef.current = writeQueueRef.current.then(async () => {
          if (fileStreamRef.current) {
            await fileStreamRef.current.write(chunk);
          }
          receivedSizeRef.current += chunk.length;
          
          if (fileInfoRef.current) {
            const p = Math.round((receivedSizeRef.current / fileInfoRef.current.size) * 100);
            setProgress(p);
          }
          updateSpeed(receivedSizeRef.current);
        });
      }
    };
  };

  const updateSpeed = (currentBytes: number) => {
    const now = Date.now();
    const timeDiff = (now - lastTimeRef.current) / 1000;
    if (timeDiff >= 1) {
      const bytesDiff = currentBytes - lastBytesRef.current;
      const mbps = (bytesDiff / (1024 * 1024)) / timeDiff;
      setTransferSpeed(mbps.toFixed(2));
      lastTimeRef.current = now;
      lastBytesRef.current = currentBytes;
    }
  };

  const calculateHash = async (buffer: ArrayBuffer) => {
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  };

  const startTransfer = async () => {
    if (!fileRef.current || !dataChannelRef.current || dataChannelRef.current.readyState !== 'open') return;
    const file = fileRef.current;
    
    setStatus(`Calculating file hash for verification...`);
    const arrayBuffer = await file.arrayBuffer();
    const fileHash = await calculateHash(arrayBuffer);
    
    dataChannelRef.current.send(JSON.stringify({
      type: 'metadata',
      name: file.name,
      size: file.size,
      hash: fileHash
    }));
    
    setStatus(`Sending ${file.name}...`);
    offsetRef.current = 0;
    lastTimeRef.current = Date.now();
    lastBytesRef.current = 0;
    readSlice();
  };

  const readSlice = () => {
    if (!fileRef.current) return;
    const file = fileRef.current;
    const slice = file.slice(offsetRef.current, offsetRef.current + CHUNK_SIZE);
    
    const reader = new FileReader();
    reader.onload = async (e) => {
      if (!e.target?.result || !dataChannelRef.current) return;
      const buffer = e.target.result as ArrayBuffer;
      
      try {
         dataChannelRef.current.send(buffer);
      } catch (err) {
         console.error("Data channel send error", err);
         return;
      }
      
      offsetRef.current += buffer.byteLength;
      const p = Math.round((offsetRef.current / file.size) * 100);
      setProgress(p);
      updateSpeed(offsetRef.current);

      if (offsetRef.current < file.size) {
        if (dataChannelRef.current.bufferedAmount > 1024 * 1024 * 5) {
          setTimeout(readSlice, 50);
        } else {
          readSlice();
        }
      } else {
        dataChannelRef.current.send(JSON.stringify({ type: 'done' }));
        setStatus('Transfer Complete!');
        setTransferSpeed('0');
      }
    };
    reader.readAsArrayBuffer(slice);
  };

  const handleDownload = async () => {
    setStatus('Processing downloaded file...');
    setProgress(100);
    setTransferSpeed('0');
    
    const currentInfo = fileInfoRef.current;
    if (!currentInfo) return;
    
    await writeQueueRef.current;
    
    if (fileStreamRef.current) {
      await fileStreamRef.current.close();
      fileStreamRef.current = null;
    }
    
    try {
      const root = await navigator.storage.getDirectory();
      const fileHandle = await root.getFileHandle('dropstream_temp');
      const diskFile = await fileHandle.getFile();
      
      if (diskFile.size <= 50 * 1024 * 1024) {
        setStatus('Verifying file integrity...');
        const arrayBuffer = await diskFile.arrayBuffer();
        const hash = await calculateHash(arrayBuffer);
        
        if (currentInfo.hash && hash !== currentInfo.hash) {
          setStatus('Verification failed! File corruption detected.');
          return;
        }
        setStatus('Verification passed! Saving file...');
      } else {
        setStatus('File too large for memory hash. Skipping verification and saving directly...');
      }
      
      const url = URL.createObjectURL(diskFile);
      setDownloadUrl(url);
      
      const a = document.createElement('a');
      a.href = url;
      a.download = currentInfo.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      
      setStatus('Transfer Complete!');
    } catch (e) {
      console.error(e);
      setStatus('Error retrieving file from local storage.');
    }
  };

  const onFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0];
      
      fileRef.current = file;
      const newMeta = { name: file.name, size: file.size };
      setFileInfo(newMeta);
      fileInfoRef.current = newMeta;
      
      if (dataChannelRef.current?.readyState === 'open') {
        startTransfer();
      }
    }
  };

  const copyLink = () => {
    navigator.clipboard.writeText(`${window.location.origin}${window.location.pathname}?room=${roomId}`);
    alert('Link copied to clipboard!');
  };

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-6 text-slate-100 font-sans">
      <div className="w-full max-w-2xl bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl relative overflow-hidden">
        
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center p-3 bg-blue-500/10 text-blue-400 rounded-xl mb-4">
            <UploadCloud size={32} />
          </div>
          <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent mb-2">
            DropStream
          </h1>
          <p className="text-slate-400">Secure, peer-to-peer file transfer.</p>
        </div>

        <div className="bg-slate-800/50 rounded-xl p-4 mb-6 border border-slate-700/50 flex items-center gap-3">
          {status.includes('Complete') || status.includes('passed') ? (
            <CheckCircle2 className="text-emerald-400 flex-shrink-0" />
          ) : status.includes('disconnect') || status.includes('failed') ? (
            <AlertCircle className="text-rose-400 flex-shrink-0" />
          ) : (
            <Loader2 className="text-blue-400 animate-spin flex-shrink-0" />
          )}
          <span className="text-sm font-medium">{status}</span>
        </div>

        {isSender && (
          <div className="mb-8">
            <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
              Share Room Link
            </label>
            <div className="flex bg-slate-950 rounded-xl border border-slate-800 overflow-hidden">
              <input 
                type="text" 
                readOnly 
                value={`${window.location.origin}${window.location.pathname}?room=${roomId}`} 
                className="bg-transparent flex-1 p-3 text-sm text-slate-300 outline-none w-full"
              />
              <button 
                onClick={copyLink}
                className="bg-blue-600 hover:bg-blue-500 transition-colors px-4 flex items-center justify-center gap-2 font-medium text-sm"
              >
                <LinkIcon size={16} /> Copy
              </button>
            </div>
            <p className="text-xs text-slate-500 mt-2">Send this link to the receiver to start the connection.</p>
          </div>
        )}

        {isSender ? (
          <div className="relative border-2 border-dashed border-slate-700 rounded-2xl p-10 flex flex-col items-center justify-center text-center transition-colors hover:border-blue-500/50 bg-slate-900/50">
            <input 
              type="file" 
              onChange={onFileSelect} 
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
            <div className="p-4 bg-slate-800 rounded-full mb-4 text-blue-400">
              <FileIcon size={32} />
            </div>
            <h3 className="font-semibold text-lg mb-1">
              {fileInfo ? fileInfo.name : 'Click or drag file to share'}
            </h3>
            <p className="text-sm text-slate-400">
              {fileInfo ? `Size: ${(fileInfo.size / (1024 * 1024)).toFixed(2)} MB` : 'Any file size supported (OPFS)'}
            </p>
          </div>
        ) : (
          <div className="border border-slate-800 bg-slate-900/50 rounded-2xl p-8 text-center flex flex-col items-center">
            <div className="p-4 bg-slate-800 rounded-full mb-4 text-emerald-400">
              <Download size={32} />
            </div>
            <h3 className="font-semibold text-lg mb-1">
              {fileInfo ? `Receiving: ${fileInfo.name}` : 'Waiting for file...'}
            </h3>
            {fileInfo && (
              <p className="text-sm text-slate-400">
                Size: {(fileInfo.size / (1024 * 1024)).toFixed(2)} MB
              </p>
            )}
            
            {downloadUrl && (
              <a 
                href={downloadUrl} 
                download={fileInfo?.name || 'download'} 
                className="mt-6 bg-emerald-600 hover:bg-emerald-500 transition-colors px-6 py-2.5 rounded-xl flex items-center gap-2 font-medium shadow-lg shadow-emerald-900/20 text-white"
              >
                <Download size={18} /> Save File Manually
              </a>
            )}
          </div>
        )}

        {(progress > 0 || status.includes('Complete')) && (
          <div className="mt-8">
            <div className="flex justify-between text-xs font-medium text-slate-400 mb-2">
              <span>Transfer Progress</span>
              <div className="space-x-4">
                <span>{transferSpeed} MB/s</span>
                <span>{progress}%</span>
              </div>
            </div>
            <div className="h-3 w-full bg-slate-800 rounded-full overflow-hidden border border-slate-700">
              <div 
                className="h-full bg-gradient-to-r from-blue-500 to-purple-500 transition-all duration-300 ease-out"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
