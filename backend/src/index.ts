import express from "express";
import http from "http";
import { Server, Socket } from "socket.io";
import cors from "cors";

const app = express();
const server = http.createServer(app);

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST"],
  }),
);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const PORT = process.env.PORT || 3001;

io.on("connection", (socket: Socket) => {
  console.log(`[+] User connected: ${socket.id}`);

  socket.on("join-room", (roomId: string) => {
    const room = io.sockets.adapter.rooms.get(roomId);
    if (room && room.size >= 2) {
      socket.emit("room-full");
      return;
    }

    socket.join(roomId);
    console.log(`[>] ${socket.id} joined room: ${roomId}`);

    socket.to(roomId).emit("peer-joined", socket.id);
  });

  socket.on("offer", (data: { offer: any; roomId: string }) => {
    socket.to(data.roomId).emit("offer", {
      offer: data.offer,
      senderId: socket.id,
    });
  });

  socket.on("answer", (data: { answer: any; roomId: string }) => {
    socket.to(data.roomId).emit("answer", {
      answer: data.answer,
      senderId: socket.id,
    });
  });

  socket.on("ice-candidate", (data: { candidate: any; roomId: string }) => {
    socket.to(data.roomId).emit("ice-candidate", {
      candidate: data.candidate,
      senderId: socket.id,
    });
  });

  socket.on("disconnecting", () => {
    for (const room of socket.rooms) {
      if (room !== socket.id) {
        socket.to(room).emit("peer-disconnected", socket.id);
      }
    }
  });

  socket.on("disconnect", () => {
    console.log(`[-] User disconnected: ${socket.id}`);
  });
});

app.get("/", (req, res) => {
  res.send("DropStream Signaling Server is running");
});

server.listen(PORT, () => {
  console.log(`Signaling server listening on port ${PORT}`);
});
