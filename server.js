import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';

const app = express();
const httpServer = createServer(app);

// Configure CORS for Socket.IO
const io = new Server(httpServer, {
  cors: {
    origin: ["https://multiplayeranime.vercel.app", "http://localhost:5173", "http://localhost:3000"],
    methods: ["GET", "POST"],
    credentials: true
  }
});

app.use(cors({
  origin: ["https://multiplayeranime.vercel.app", "http://localhost:5173", "http://localhost:3000"],
  credentials: true
}));
app.use(express.json());

// In-memory storage for rooms
const rooms = new Map();

// Generate a unique 5-digit room code
function generateRoomCode() {
  return Math.floor(10000 + Math.random() * 90000).toString();
}

// Socket.IO connection handler
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Create room
  socket.on('createRoom', (data) => {
    const { nickname } = data;
    const roomCode = generateRoomCode();
    
    // Create room object
    const room = {
      code: roomCode,
      host: socket.id,
      hostNickname: nickname,
      members: new Map([[socket.id, { nickname, isHost: true }]]),
      currentEpisode: null,
      animeId: null,
      videoState: {
        isPlaying: false,
        currentTime: 0,
        lastUpdate: Date.now()
      },
      chat: []
    };
    
    rooms.set(roomCode, room);
    socket.join(roomCode);
    socket.roomCode = roomCode;
    
    socket.emit('roomCreated', { 
      roomCode, 
      isHost: true,
      members: Array.from(room.members.values())
    });
    
    console.log(`Room ${roomCode} created by ${nickname}`);
  });

  // Join room
  socket.on('joinRoom', (data) => {
    const { roomCode, nickname } = data;
    const room = rooms.get(roomCode);
    
    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }
    
    // Check if room is full (max 10 people)
    if (room.members.size >= 10) {
      socket.emit('error', { message: 'Room is full' });
      return;
    }
    
    // Add user to room
    room.members.set(socket.id, { nickname, isHost: false });
    socket.join(roomCode);
    socket.roomCode = roomCode;
    
    // Notify room members
    io.to(roomCode).emit('userJoined', { 
      nickname,
      members: Array.from(room.members.values())
    });
    
    // Send room state to new member
    socket.emit('roomJoined', {
      roomCode,
      isHost: false,
      currentEpisode: room.currentEpisode,
      animeId: room.animeId,
      videoState: room.videoState,
      members: Array.from(room.members.values()),
      chat: room.chat.slice(-50) // Send last 50 messages
    });
    
    console.log(`${nickname} joined room ${roomCode}`);
  });

  // Video control events
  socket.on('videoAction', (data) => {
    const { action } = data;
    const roomCode = socket.roomCode;
    const room = rooms.get(roomCode);
    
    if (!room || room.host !== socket.id) {
      return; // Only host can control video
    }
    
    // Update room state
    room.videoState = {
      ...action,
      lastUpdate: Date.now()
    };
    
    // Broadcast to other members (not the host)
    socket.to(roomCode).emit('videoAction', action);
    console.log(`Video action in room ${roomCode}:`, action);
  });

  // Episode change
  socket.on('changeEpisode', (data) => {
    const { episodeId, animeId } = data;
    const roomCode = socket.roomCode;
    const room = rooms.get(roomCode);
    
    if (!room || room.host !== socket.id) {
      return; // Only host can change episode
    }
    
    room.currentEpisode = episodeId;
    room.animeId = animeId;
    
    // Broadcast to all room members including host
    io.to(roomCode).emit('changeEpisode', { episodeId, animeId });
    console.log(`Episode changed in room ${roomCode} to ${episodeId}`);
  });

  // Chat messages
  socket.on('chatMessage', (data) => {
    const { message } = data;
    const roomCode = socket.roomCode;
    const room = rooms.get(roomCode);
    
    if (!room || !room.members.has(socket.id)) {
      return;
    }
    
    const member = room.members.get(socket.id);
    const chatMessage = {
      id: uuidv4(),
      nickname: member.nickname,
      message,
      timestamp: Date.now(),
      isHost: member.isHost
    };
    
    room.chat.push(chatMessage);
    
    // Keep only last 100 messages
    if (room.chat.length > 100) {
      room.chat = room.chat.slice(-100);
    }
    
    // Broadcast to all room members
    io.to(roomCode).emit('chatMessage', chatMessage);
  });

  // Get room info
  socket.on('getRoomInfo', (roomCode) => {
    const room = rooms.get(roomCode);
    if (room) {
      socket.emit('roomInfo', {
        members: Array.from(room.members.values()),
        currentEpisode: room.currentEpisode,
        animeId: room.animeId,
        videoState: room.videoState
      });
    } else {
      socket.emit('error', { message: 'Room not found' });
    }
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    const roomCode = socket.roomCode;
    if (roomCode) {
      const room = rooms.get(roomCode);
      if (room) {
        const member = room.members.get(socket.id);
        room.members.delete(socket.id);
        
        if (room.members.size === 0) {
          // Delete empty room
          rooms.delete(roomCode);
          console.log(`Room ${roomCode} deleted - no members left`);
        } else {
          // If host left, assign new host
          if (room.host === socket.id) {
            const newHost = room.members.keys().next().value;
            room.host = newHost;
            const newHostMember = room.members.get(newHost);
            newHostMember.isHost = true;
            
            io.to(roomCode).emit('newHost', { 
              newHostId: newHost,
              newHostNickname: newHostMember.nickname,
              members: Array.from(room.members.values())
            });
          }
          
          // Notify remaining members
          io.to(roomCode).emit('userLeft', { 
            nickname: member?.nickname,
            members: Array.from(room.members.values())
          });
        }
      }
    }
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Multiplayer server running on port ${PORT}`);
});
