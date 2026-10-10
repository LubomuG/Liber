require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const emoji = require('node-emoji');
const { Server } = require('socket.io');

const { Schema, model } = mongoose;
const collation = { locale: 'en', strength: 2 };
const TOKEN_TTL = '7d';
const tokenSecret = process.env.JWT_SECRET;
const mongoUri = process.env.MONGO_URI;
const port = Number(process.env.PORT) || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server);
let bucket;

const userSchema = new Schema({
  username: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  phone: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  avatar: { type: String, default: '' }
}, { timestamps: true });
userSchema.index({ username: 1 }, { unique: true, collation });
userSchema.methods.toPublic = function () {
  return { id: this.id, username: this.username, avatar: this.avatar };
};

const roomSchema = new Schema({
  key: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  type: { type: String, enum: ['public', 'group', 'dm'], required: true },
  members: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  owner: { type: Schema.Types.ObjectId, ref: 'User' },
  inviteCode: { type: String, unique: true, sparse: true }
}, { timestamps: true });

const messageSchema = new Schema({
  room: { type: Schema.Types.ObjectId, ref: 'Room', required: true, index: true },
  author: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  kind: { type: String, enum: ['text', 'image', 'voice', 'circle'], required: true },
  text: { type: String, default: '' },
  file: { type: String, default: '' }
}, { timestamps: true });
messageSchema.index({ room: 1, createdAt: -1 });

const User = model('User', userSchema);
const Room = model('Room', roomSchema);
const Message = model('Message', messageSchema);

const extensions = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  'audio/webm': '.webm', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a',
  'video/webm': '.webm', 'video/mp4': '.mp4'
};
const mimeForExtension = Object.fromEntries(Object.entries(extensions).map(([mime, extension]) => [extension, mime]));
const makeUpload = maxSize => multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, callback) => callback(null, Boolean(extensions[file.mimetype.split(';')[0]])),
  limits: { fileSize: maxSize, files: 1 }
});
const upload = makeUpload(25 * 1024 * 1024);
const avatarParser = makeUpload(5 * 1024 * 1024);
const avatarUpload = (req, res, next) => {
  avatarParser.single('avatar')(req, res, error => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'file_too_large' });
    if (error) return res.status(400).json({ error: 'upload_failed' });
    next();
  });
};
const fileUpload = (req, res, next) => {
  upload.single('file')(req, res, error => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'file_too_large' });
    if (error) return res.status(400).json({ error: 'upload_failed' });
    next();
  });
};
const signSession = user => ({
  token: jwt.sign({ sub: user.id }, tokenSecret, { expiresIn: TOKEN_TTL }),
  user: user.toPublic()
});
const setSessionCookie = (res, user) => {
  const token = jwt.sign({ sub: user.id }, tokenSecret, { expiresIn: TOKEN_TTL });
  res.cookie('liber_session', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 60 * 60 * 1000, path: '/' });
};
const isObjectId = value => mongoose.isValidObjectId(value);
const getUserFromToken = token => {
  const decoded = jwt.verify(token, tokenSecret);
  if (!decoded.sub || !isObjectId(decoded.sub)) throw new Error('invalid token');
  return User.findById(decoded.sub);
};
const requireAuth = async (req, res, next) => {
  try {
    const header = req.get('authorization') || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    const token = (match && match[1]) || req.cookies?.liber_session;
    if (!token) return res.status(401).json({ error: 'unauthorized' });
    const user = await getUserFromToken(token);
    if (!user) return res.status(401).json({ error: 'unauthorized' });
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
  author: { id: message.author.id, username: message.author.username, avatar: message.author.avatar }
});
const serializeRoom = (room, meId, includeInvite = false) => {
  const result = { id: room.id, name: room.name, type: room.type, avatar: '', isOwner: Boolean(room.owner && room.owner.equals(meId)) };
  if (room.type === 'dm') {
    const other = room.members.find(member => member.id !== meId);
    result.name = other ? other.username : 'Direct chat';
    result.avatar = other ? other.avatar : '';
  }
  if (includeInvite && room.inviteCode) result.inviteCode = room.inviteCode;
  return result;
};
const canAccess = (room, userId) => room.type === 'public' || room.members.some(member => member.equals(userId));
const parseUser = async token => getUserFromToken(token);
const emojiList = (() => {
  const found = new Map();
  'abcdefghijklmnopqrstuvwxyz'.split('').flatMap(letter => emoji.search(letter)).forEach(item => found.set(item.key || item.name, item.emoji));
  return [...found].map(([name, char]) => ({ name, char }));
})();
const usernameRe = /^[\w.\-а-яіїєґА-ЯІЇЄҐ]{2,20}$/;
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phoneRe = /^\+?\d{7,15}$/;
const messageKinds = ['text', 'image', 'voice', 'circle'];
const fileIdPattern = /^[a-f\d]{24}$/i;

const putFile = (buffer, filename, mimeType, metadata) => new Promise((resolve, reject) => {
  const stream = bucket.openUploadStream(filename, { contentType: mimeType, metadata });
  stream.on('error', reject);
  stream.on('finish', () => resolve(stream.id.toString()));
  stream.end(buffer);
});
const getFile = async id => {
  if (!fileIdPattern.test(id)) return null;
  return mongoose.connection.db.collection('uploads.files').findOne({ _id: new mongoose.mongo.ObjectId(id) });
};
const fileUrl = id => `/api/files/${id}`;
const emitRoomUpdate = async room => {
  const members = await User.find({ _id: { $in: room.members } }).select('_id');
  for (const member of members) io.to(`user:${member.id}`).emit('room:updated', serializeRoom(room, member.id));
};
const issueInviteCode = () => crypto.randomBytes(6).toString('base64url');
const proxySetting = String(process.env.TRUST_PROXY || '').trim().replace(/;$/, '');
const trustedProxy = /^\d+$/.test(proxySetting) ? Number(proxySetting) : ['loopback', 'linklocal', 'uniquelocal'].includes(proxySetting.toLowerCase()) ? proxySetting.toLowerCase() : false;

app.set('trust proxy', trustedProxy);
app.use((req, res, next) => {
  const value = req.headers.cookie || '';
  req.cookies = Object.fromEntries(value.split(';').map(part => part.trim().split(/=(.*)/s).slice(0, 2)).filter(([key, val]) => key && val !== undefined).map(([key, val]) => {
    try {
      return [key, decodeURIComponent(val)];
    } catch {
      return [key, ''];
    }
  }));
  next();
});
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false }));

app.post('/api/register', rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false }), avatarUpload, async (req, res, next) => {
  try {
    const username = String(req.body.username || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const phone = String(req.body.phone || '').replace(/[\s()-]/g, '');
    const password = String(req.body.password || '');
    if (!usernameRe.test(username)) return res.status(400).json({ error: 'invalid_username' });
    if (!emailRe.test(email)) return res.status(400).json({ error: 'invalid_email' });
    if (!phoneRe.test(phone)) return res.status(400).json({ error: 'invalid_phone' });
    if (password.length < 9 || password.length > 128) return res.status(400).json({ error: 'weak_password' });
    if (req.file && !req.file.mimetype.startsWith('image/')) return res.status(400).json({ error: 'avatar_type' });
    if (req.file && req.file.size > 5 * 1024 * 1024) return res.status(413).json({ error: 'file_too_large' });
    const taken = await User.findOne({ $or: [{ email }, { phone }, { username }] }).collation(collation);
    if (taken) return res.status(409).json({ error: 'exists' });
    const user = await User.create({ username, email, phone, password: await bcrypt.hash(password, 10) });
    if (req.file) {
      const extension = extensions[req.file.mimetype];
      const id = await putFile(req.file.buffer, `${crypto.randomUUID()}${extension}`, req.file.mimetype, { owner: user._id, purpose: 'avatar' });
      user.avatar = fileUrl(id);
      await user.save();
    }
    setSessionCookie(res, user);
    res.json(signSession(user));
  } catch (error) {
    next(error);
  }
});

app.post('/api/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, skipSuccessfulRequests: true }), async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ error: 'invalid_credentials' });
    const legacyMatch = !user.password.startsWith('$2') && user.password === password;
    const valid = legacyMatch || await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'invalid_credentials' });
    if (legacyMatch) {
      user.password = await bcrypt.hash(password, 10);
      await user.save();
    }
    setSessionCookie(res, user);
    res.json(signSession(user));
  } catch (error) {
    next(error);
  }
});

app.get('/api/me', requireAuth, (req, res) => {
  setSessionCookie(res, req.user);
  res.json(signSession(req.user));
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('liber_session', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' });
  res.json({ ok: true });
});

app.get('/api/rooms', requireAuth, async (req, res, next) => {
  try {
    const rooms = await Room.find({ $or: [{ type: 'public' }, { members: req.user._id }] }).sort({ createdAt: 1 });
    res.json(rooms.map(room => serializeRoom(room, req.user.id)));
  } catch (error) {
    next(error);
  }
});

app.post('/api/rooms/dm', requireAuth, async (req, res, next) => {
  try {
    const other = await User.findOne({ username: String(req.body.username || '').trim() }).collation(collation);
    if (!other) return res.status(404).json({ error: 'not_found' });
    if (other.id === req.user.id) return res.status(400).json({ error: 'self' });
    const key = `dm:${[req.user.id, other.id].sort().join(':')}`;
    const room = await Room.findOneAndUpdate({ key }, { $setOnInsert: { name: key, type: 'dm', members: [req.user._id, other._id] } }, { upsert: true, new: true });
    io.in(`user:${req.user.id}`).socketsJoin(`room:${room.id}`);
    io.in(`user:${other.id}`).socketsJoin(`room:${room.id}`);
    await emitRoomUpdate(room);
    res.json(serializeRoom(room, req.user.id));
  } catch (error) {
    next(error);
  }
});

app.post('/api/rooms/group', requireAuth, async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    if (name.length < 2 || name.length > 30) return res.status(400).json({ error: 'invalid_name' });
    const room = await Room.create({ key: `group:${crypto.randomUUID()}`, name, type: 'group', members: [req.user._id], owner: req.user._id, inviteCode: issueInviteCode() });
    io.in(`user:${req.user.id}`).socketsJoin(`room:${room.id}`);
    res.json(serializeRoom(room, req.user.id, true));
  } catch (error) {
    next(error);
  }
});

app.post('/api/rooms/join', requireAuth, async (req, res, next) => {
  try {
    const code = String(req.body.inviteCode || '').trim();
    const room = await Room.findOne({ type: 'group', inviteCode: code });
    if (!room) return res.status(404).json({ error: 'invalid_invite' });
    room.members.addToSet(req.user._id);
    await room.save();
    io.in(`user:${req.user.id}`).socketsJoin(`room:${room.id}`);
    await emitRoomUpdate(room);
    res.json(serializeRoom(room, req.user.id));
  } catch (error) {
    next(error);
  }
});

app.post('/api/rooms/:id/invite', requireAuth, async (req, res, next) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(404).json({ error: 'not_found' });
    const room = await Room.findById(req.params.id);
    if (!room || room.type !== 'group' || !room.owner || !room.owner.equals(req.user._id)) return res.status(404).json({ error: 'not_found' });
    room.inviteCode = issueInviteCode();
    await room.save();
    res.json({ inviteCode: room.inviteCode });
  } catch (error) {
    next(error);
  }
});

app.post('/api/rooms/:id/leave', requireAuth, async (req, res, next) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(404).json({ error: 'not_found' });
    const room = await Room.findById(req.params.id);
    if (!room || room.type !== 'group' || !canAccess(room, req.user._id)) return res.status(404).json({ error: 'not_found' });
    room.members.pull(req.user._id);
    if (room.owner && room.owner.equals(req.user._id)) room.owner = room.members[0] || undefined;
    if (!room.members.length) {
      await Message.deleteMany({ room: room._id });
      await Room.deleteOne({ _id: room._id });
    } else {
      await room.save();
      await emitRoomUpdate(room);
    }
    io.in(`user:${req.user.id}`).socketsLeave(`room:${room.id}`);
    io.to(`user:${req.user.id}`).emit('room:removed', room.id);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/rooms/:id/messages', requireAuth, async (req, res, next) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(404).json({ error: 'not_found' });
    const room = await Room.findById(req.params.id);
    if (!room || !canAccess(room, req.user._id)) return res.status(404).json({ error: 'not_found' });
    const messages = await Message.find({ room: room._id }).sort({ createdAt: -1 }).limit(100).populate('author', 'username avatar');
    res.json(messages.reverse().map(serializeMessage));
  } catch (error) {
    next(error);
  }
});

app.post('/api/upload', requireAuth, fileUpload, async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'upload_failed' });
    const purpose = String(req.body.purpose || 'message');
    if (purpose === 'message') {
      if (!isObjectId(req.body.roomId)) return res.status(400).json({ error: 'not_found' });
      const room = await Room.findById(req.body.roomId);
      if (!room || !canAccess(room, req.user._id)) return res.status(404).json({ error: 'not_found' });
      if (!['image', 'voice', 'circle'].includes(String(req.body.kind))) return res.status(400).json({ error: 'upload_failed' });
      if (req.body.kind === 'image' && !req.file.mimetype.startsWith('image/')) return res.status(400).json({ error: 'avatar_type' });
      if (req.body.kind === 'voice' && !req.file.mimetype.startsWith('audio/')) return res.status(400).json({ error: 'upload_failed' });
      if (req.body.kind === 'circle' && !req.file.mimetype.startsWith('video/')) return res.status(400).json({ error: 'upload_failed' });
      const id = await putFile(req.file.buffer, `${crypto.randomUUID()}${extensions[req.file.mimetype.split(';')[0]]}`, req.file.mimetype, { owner: req.user._id, room: room._id, purpose });
      return res.json({ url: fileUrl(id) });
    }
    if (purpose === 'background') {
      if (!req.file.mimetype.startsWith('image/')) return res.status(400).json({ error: 'avatar_type' });
      const id = await putFile(req.file.buffer, `${crypto.randomUUID()}${extensions[req.file.mimetype.split(';')[0]]}`, req.file.mimetype, { owner: req.user._id, purpose });
      return res.json({ url: fileUrl(id) });
    }
    res.status(400).json({ error: 'upload_failed' });
  } catch (error) {
    next(error);
  }
});

app.get('/api/files/:id', requireAuth, async (req, res, next) => {
  try {
    const file = await getFile(req.params.id);
    if (!file) return res.status(404).json({ error: 'not_found' });
    const metadata = file.metadata || {};
    const allowedAvatar = metadata.purpose === 'avatar';
    const allowedOwner = metadata.owner && metadata.owner.equals(req.user._id) && metadata.purpose === 'background';
    let allowedRoom = false;
    if (metadata.purpose === 'message' && metadata.room) {
      const room = await Room.findById(metadata.room);
      allowedRoom = Boolean(room && canAccess(room, req.user._id));
    }
    if (!allowedAvatar && !allowedOwner && !allowedRoom) return res.status(404).json({ error: 'not_found' });
    res.set('Content-Type', file.contentType || 'application/octet-stream');
    res.set('Content-Length', String(file.length));
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'private, max-age=3600');
    bucket.openDownloadStream(file._id).pipe(res);
  } catch (error) {
    next(error);
  }
});

app.get('/api/emojis', requireAuth, (req, res) => res.json(emojiList));

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error.code === 11000) return res.status(409).json({ error: 'exists' });
  console.error('Request failed:', error.message);
  res.status(500).json({ error: 'generic' });
});

io.use(async (socket, next) => {
  try {
    const user = await parseUser(socket.handshake.auth.token);
    if (!user) throw new Error('unauthorized');
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
    try {
      if (!messageKinds.includes(kind) || !isObjectId(roomId)) return;
      const room = await Room.findById(roomId);
      if (!room || !canAccess(room, user._id)) return;
      const data = { room: room._id, author: user._id, kind };
      if (kind === 'text') {
        const clean = String(text || '').trim().slice(0, 2000);
        if (!clean) return;
        data.text = emoji.emojify(clean);
      } else {
        if (!fileIdPattern.test(String(file || '').split('/').pop())) return;
        const fileId = String(file).split('/').pop();
        const storedFile = await getFile(fileId);
        const metadata = storedFile && storedFile.metadata;
        if (!metadata || metadata.purpose !== 'message' || !metadata.owner.equals(user._id) || !metadata.room.equals(room._id)) return;
        data.file = fileUrl(fileId);
      }
      const message = await (await Message.create(data)).populate('author', 'username avatar');
      io.to(`room:${room.id}`).emit('message', serializeMessage(message));
    } catch (error) {
      console.error('Message failed:', error.message);
    }
  });
});

const start = async () => {
  if (!mongoUri || !tokenSecret) throw new Error('Set MONGO_URI and JWT_SECRET in .env or the service environment.');
  await mongoose.connect(mongoUri);
  bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'uploads' });
  await Room.findOneAndUpdate({ key: 'general' }, { $setOnInsert: { name: 'General', type: 'public' } }, { upsert: true });
  for await (const room of Room.find({ type: 'group' })) {
    let changed = false;
    if (!room.owner && room.members.length) {
      room.owner = room.members[0];
      changed = true;
    }
    if (!room.inviteCode) {
      room.inviteCode = issueInviteCode();
      changed = true;
    }
    if (changed) await room.save();
  }
  const migrateLocalFile = async (url, metadata, mimeOverride = '') => {
    const match = String(url || '').match(/^\/uploads\/([\w.-]+)$/);
    if (!match) return '';
    const localPath = path.join(__dirname, 'uploads', path.basename(match[1]));
    const extension = path.extname(localPath).toLowerCase();
    const mimeType = mimeOverride || mimeForExtension[extension];
    if (!mimeType || !fs.existsSync(localPath)) return '';
    const id = await putFile(fs.readFileSync(localPath), `${crypto.randomUUID()}${extension}`, mimeType, metadata);
    return fileUrl(id);
  };
  for await (const user of User.find({ avatar: /^\/uploads\// })) {
    const avatar = await migrateLocalFile(user.avatar, { owner: user._id, purpose: 'avatar' });
    if (avatar) {
      user.avatar = avatar;
      await user.save();
    }
  }
  for await (const message of Message.find({ file: /^\/uploads\// }).populate('room').populate('author')) {
    if (!message.room || !message.author) continue;
    const mimeOverride = message.kind === 'voice' && path.extname(message.file).toLowerCase() === '.webm' ? 'audio/webm' : '';
    const migrated = await migrateLocalFile(message.file, { owner: message.author._id, room: message.room._id, purpose: 'message' }, mimeOverride);
    if (migrated) {
      message.file = migrated;
      await message.save();
    }
  }
  server.listen(port, () => console.log(`Server started on port ${port}`));
};

start().catch(error => {
  console.error('Startup failed:', error.message);
  process.exit(1);
});
