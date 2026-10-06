require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const emoji = require('node-emoji');
const { Server } = require('socket.io');

const { Schema, model } = mongoose;
const collation = { locale: 'en', strength: 2 };

const userSchema = new Schema(
  {
    username: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    avatar: { type: String, default: '' }
  },
  { timestamps: true }
);
userSchema.index({ username: 1 }, { unique: true, collation });
userSchema.methods.toPublic = function () {
  return { id: this.id, username: this.username, avatar: this.avatar };
};

const roomSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    type: { type: String, enum: ['public', 'group', 'dm'], required: true },
    members: [{ type: Schema.Types.ObjectId, ref: 'User' }]
  },
  { timestamps: true }
);

const messageSchema = new Schema(
  {
    room: { type: Schema.Types.ObjectId, ref: 'Room', required: true, index: true },
    author: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: ['text', 'image', 'voice', 'circle'], required: true },
    text: { type: String, default: '' },
    file: { type: String, default: '' }
  },
  { timestamps: true }
);

const User = model('User', userSchema);
const Room = model('Room', roomSchema);
const Message = model('Message', messageSchema);

const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const extensions = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'audio/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'video/webm': '.webm',
  'video/mp4': '.mp4'
};

const baseType = file => file.mimetype.split(';')[0];

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${extensions[baseType(file)]}`)
  }),
  fileFilter: (req, file, cb) => cb(null, Boolean(extensions[baseType(file)])),
  limits: { fileSize: 25 * 1024 * 1024 }
});

const session = user => ({ token: user.id, user: user.toPublic() });

const requireAuth = async (req, res, next) => {
  try {
    const user = await User.findById((req.headers.authorization || '').replace('Bearer ', ''));
    if (!user) throw new Error('user not found');
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'unauthorized' });
  }
};

const serializeMessage = message => ({
  id: message.id,
  room: message.room.toString(),
  kind: message.kind,
  text: message.text,
  file: message.file,
  createdAt: message.createdAt,
  author: {
    id: message.author.id,
    username: message.author.username,
    avatar: message.author.avatar
  }
});

const serializeRoom = (room, meId) => {
  if (room.type !== 'dm') return { id: room.id, name: room.name, type: room.type, avatar: '' };
  const other = room.members.find(member => member.id !== meId);
  return { id: room.id, name: other.username, type: 'dm', avatar: other.avatar };
};

const canAccess = (room, userId) =>
  room.type === 'public' || room.members.some(member => member.equals(userId));

const populateMembers = query => query.populate('members', 'username avatar');

const emojiList = (() => {
  const found = new Map();
  'abcdefghijklmnopqrstuvwxyz'
    .split('')
    .flatMap(letter => emoji.search(letter))
    .forEach(item => found.set(item.key || item.name, item.emoji));
  return [...found].map(([name, char]) => ({ name, char }));
})();

const usernameRe = /^[\w.\-а-яіїєґА-ЯІЇЄҐ]{2,20}$/;
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phoneRe = /^\+?\d{7,15}$/;
const messageKinds = ['text', 'image', 'voice', 'circle'];
const filePattern = /^\/uploads\/[\w-]+\.\w+$/;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir, { setHeaders: res => res.set('X-Content-Type-Options', 'nosniff') }));

app.post('/api/register', upload.single('avatar'), async (req, res) => {
  const username = String(req.body.username || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const phone = String(req.body.phone || '').replace(/[\s()-]/g, '');
  const password = String(req.body.password || '');

  if (!usernameRe.test(username)) return res.status(400).json({ error: 'invalid_username' });
  if (!emailRe.test(email)) return res.status(400).json({ error: 'invalid_email' });
  if (!phoneRe.test(phone)) return res.status(400).json({ error: 'invalid_phone' });
  if (password.length < 9) return res.status(400).json({ error: 'weak_password' });
  if (req.file && !req.file.mimetype.startsWith('image/')) return res.status(400).json({ error: 'avatar_type' });

  const taken = await User.findOne({ $or: [{ email }, { phone }, { username }] }).collation(collation);
  if (taken) return res.status(409).json({ error: 'exists' });

  const user = await User.create({
    username,
    email,
    phone,
    password,
    avatar: req.file ? `/uploads/${req.file.filename}` : ''
  });
  res.json(session(user));
});

app.post('/api/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = await User.findOne({ email });
  const valid = user && user.password === String(req.body.password || '');
  if (!valid) return res.status(401).json({ error: 'invalid_credentials' });
  res.json(session(user));
});

app.get('/api/me', requireAuth, (req, res) => res.json(session(req.user)));

app.get('/api/rooms', requireAuth, async (req, res) => {
  const rooms = await populateMembers(
    Room.find({ $or: [{ type: 'public' }, { members: req.user._id }] }).sort({ createdAt: 1 })
  );
  res.json(rooms.map(room => serializeRoom(room, req.user.id)));
});

const joinUsers = (room, userIds) => {
  userIds.forEach(id => {
    io.in(`user:${id}`).socketsJoin(`room:${room.id}`);
    io.to(`user:${id}`).emit('room:new', serializeRoom(room, id));
  });
};

app.post('/api/rooms/dm', requireAuth, async (req, res) => {
  const other = await User.findOne({ username: String(req.body.username || '').trim() }).collation(collation);
  if (!other) return res.status(404).json({ error: 'not_found' });
  if (other.id === req.user.id) return res.status(400).json({ error: 'self' });

  const key = `dm:${[req.user.id, other.id].sort().join(':')}`;
  const room = await populateMembers(
    Room.findOneAndUpdate(
      { key },
      { $setOnInsert: { name: key, type: 'dm', members: [req.user._id, other._id] } },
      { upsert: true, new: true }
    )
  );
  joinUsers(room, [req.user.id, other.id]);
  res.json(serializeRoom(room, req.user.id));
});

app.post('/api/rooms/group', requireAuth, async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (name.length < 2 || name.length > 30) return res.status(400).json({ error: 'invalid_name' });

  const room = await Room.findOneAndUpdate(
    { key: `group:${name.toLowerCase()}` },
    { $setOnInsert: { name, type: 'group' }, $addToSet: { members: req.user._id } },
    { upsert: true, new: true }
  );
  joinUsers(room, [req.user.id]);
  res.json(serializeRoom(room, req.user.id));
});

app.get('/api/rooms/:id/messages', requireAuth, async (req, res) => {
  const room = await Room.findById(req.params.id);
  if (!room || !canAccess(room, req.user._id)) return res.status(404).json({ error: 'not_found' });

  const messages = await Message.find({ room: room._id })
    .sort({ createdAt: -1 })
    .limit(100)
    .populate('author', 'username avatar');
  res.json(messages.reverse().map(serializeMessage));
});

app.post('/api/upload', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'upload_failed' });
  res.json({ url: `/uploads/${req.file.filename}` });
});

app.get('/api/emojis', requireAuth, (req, res) => res.json(emojiList));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'generic' });
});

io.use(async (socket, next) => {
  try {
    const user = await User.findById(socket.handshake.auth.token);
    if (!user) throw new Error('user not found');
    socket.user = user;
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});

io.on('connection', async socket => {
  const { user } = socket;
  socket.join(`user:${user.id}`);

  const rooms = await Room.find({ $or: [{ type: 'public' }, { members: user._id }] }).select('_id');
  rooms.forEach(room => socket.join(`room:${room.id}`));

  socket.on('message', async ({ roomId, kind, text, file } = {}) => {
    if (!messageKinds.includes(kind)) return;

    const room = await Room.findById(roomId).catch(() => null);
    if (!room || !canAccess(room, user._id)) return;

    const data = { room: room._id, author: user._id, kind };

    if (kind === 'text') {
      const clean = String(text || '').trim().slice(0, 2000);
      if (!clean) return;
      data.text = emoji.emojify(clean);
    } else {
      if (!filePattern.test(file)) return;
      data.file = file;
    }

    const message = await (await Message.create(data)).populate('author', 'username avatar');
    io.to(`room:${room.id}`).emit('message', serializeMessage(message));
  });
});

const PORT = Number(process.env.PORT) || 3000;

mongoose.connect(process.env.MONGO_URI).then(async () => {
  await Room.findOneAndUpdate(
    { key: 'general' },
    { $setOnInsert: { name: 'General', type: 'public' } },
    { upsert: true }
  );

  server.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
  });
});