require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const emoji = require('node-emoji');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');

const { MONGO_URI, JWT_SECRET } = process.env;
if (!MONGO_URI || !JWT_SECRET) {
  console.error('Missing configuration: set MONGO_URI and JWT_SECRET in .env (see .env.example).');
  process.exit(1);
}

const { Schema, model } = mongoose;
const collation = { locale: 'en', strength: 2 };

const TOKEN_TTL = 7 * 24 * 60 * 60;
const COOKIE_NAME = 'liber_token';
const PAGE_SIZE = 50;
const MB = 1024 * 1024;

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

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
    members: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    owner: { type: Schema.Types.ObjectId, ref: 'User' },
    inviteCode: { type: String }
  },
  { timestamps: true }
);
roomSchema.index({ inviteCode: 1 }, { unique: true, sparse: true });

const messageSchema = new Schema(
  {
    room: { type: Schema.Types.ObjectId, ref: 'Room', required: true },
    author: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: ['text', 'image', 'voice', 'circle'], required: true },
    text: { type: String, default: '' },
    file: { type: String, default: '' }
  },
  { timestamps: true }
);
messageSchema.index({ room: 1, _id: -1 });

const readStateSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  room: { type: Schema.Types.ObjectId, ref: 'Room', required: true },
  lastReadAt: { type: Date, required: true }
});
readStateSchema.index({ user: 1, room: 1 }, { unique: true });

const User = model('User', userSchema);
const Room = model('Room', roomSchema);
const Message = model('Message', messageSchema);
const ReadState = model('ReadState', readStateSchema);


let bucket;

const allowedMimes = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'audio/webm',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'video/webm',
  'video/mp4'
]);
const kindPrefix = { image: 'image/', voice: 'audio/', circle: 'video/' };

const baseType = file => String(file.mimetype || '').split(';')[0].trim().toLowerCase();
const idRe = /^[a-f0-9]{24}$/;
const filePattern = /^\/uploads\/[a-f0-9]{24}$/;

const saveFile = (buffer, { name, mime, owner, room, purpose }) =>
  new Promise((resolve, reject) => {
    const stream = bucket.openUploadStream(name || 'file', {
      metadata: { owner, room: room || null, purpose, mime }
    });
    stream.once('error', reject);
    stream.once('finish', () => resolve(stream.id));
    stream.end(buffer);
  });

const findFile = async id => {
  if (!idRe.test(String(id))) return null;
  const [file] = await bucket.find({ _id: new mongoose.Types.ObjectId(id) }).limit(1).toArray();
  return file || null;
};

const removeFile = id => bucket.delete(id).catch(() => {});

const memory = multer.memoryStorage();

const upload = multer({
  storage: memory,
  fileFilter: (req, file, cb) =>
    allowedMimes.has(baseType(file)) ? cb(null, true) : cb(new HttpError(400, 'upload_failed')),
  limits: { fileSize: 25 * MB, files: 1 }
});

const avatarUpload = multer({
  storage: memory,
  fileFilter: (req, file, cb) =>
    baseType(file).startsWith('image/') && allowedMimes.has(baseType(file))
      ? cb(null, true)
      : cb(new HttpError(400, 'avatar_type')),
  limits: { fileSize: 5 * MB, files: 1 }
});


const signToken = user => jwt.sign({ id: user.id }, JWT_SECRET, { algorithm: 'HS256', expiresIn: TOKEN_TTL });

const userFromToken = async token => {
  try {
    const { id } = jwt.verify(String(token || ''), JWT_SECRET, { algorithms: ['HS256'] });
    return await User.findById(id);
  } catch {
    return null;
  }
};

const readCookie = (req, name) => {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return '';
      }
    }
  }
  return '';
};

const bearer = req => (req.headers.authorization || '').replace(/^Bearer /, '');

const sendSession = (req, res, user) => {
  const token = signToken(user);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.secure,
    maxAge: TOKEN_TTL * 1000,
    path: '/'
  });
  res.json({ token, user: user.toPublic() });
};

const authWith = getToken => async (req, res, next) => {
  const user = await userFromToken(getToken(req));
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  req.user = user;
  next();
};

const requireAuth = authWith(bearer);
const requireFileAuth = authWith(req => bearer(req) || readCookie(req, COOKIE_NAME));

const legacyHash = /^\$2[aby]\$/;
const DUMMY_HASH = bcrypt.hashSync('liber-dummy-password', 10);


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

const serializeRoom = (room, meId, unread = 0) => {
  const base = { id: room.id, type: room.type, unread };
  if (room.type === 'dm') {
    const other = room.members.find(member => member.id !== meId);
    return { ...base, name: other.username, avatar: other.avatar };
  }
  if (room.type === 'group') {
    return {
      ...base,
      name: room.name,
      avatar: '',
      inviteCode: room.inviteCode || '',
      isOwner: String(room.owner) === meId
    };
  }
  return { ...base, name: room.name, avatar: '' };
};

const canAccess = (room, userId) =>
  room.type === 'public' || room.members.some(member => member.equals(userId));

const populateMembers = query => query.populate('members', 'username avatar');

const newInviteCode = () => crypto.randomBytes(6).toString('base64url');

const findRoom = id => (idRe.test(String(id)) ? Room.findById(id) : null);

const destroyRoom = async room => {
  const files = await bucket.find({ 'metadata.room': room._id }).toArray();
  await Promise.all(files.map(file => removeFile(file._id)));
  await Message.deleteMany({ room: room._id });
  await ReadState.deleteMany({ room: room._id });
  await room.deleteOne();
};

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


const app = express();
const server = http.createServer(app);
const io = new Server(server);

if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);

const limiter = (windowMs, limit, extra = {}) =>
  rateLimit({ windowMs, limit, standardHeaders: true, legacyHeaders: false, message: { error: 'too_many' }, ...extra });

const apiLimiter = limiter(60 * 1000, 300);
const loginLimiter = limiter(15 * 60 * 1000, 10, { skipSuccessfulRequests: true });
const registerLimiter = limiter(60 * 60 * 1000, 10);
const uploadLimiter = limiter(60 * 1000, 30);

app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const vendor = (route, ...parts) =>
  app.use(route, express.static(path.join(__dirname, 'node_modules', ...parts)));
vendor('/vendor/jquery', 'jquery', 'dist');
vendor('/vendor/fontawesome', '@fortawesome', 'fontawesome-free');

app.use('/api', apiLimiter);

app.post('/api/register', registerLimiter, avatarUpload.single('avatar'), async (req, res) => {
  const username = String(req.body.username || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const phone = String(req.body.phone || '').replace(/[\s()-]/g, '');
  const password = String(req.body.password || '');

  if (!usernameRe.test(username)) throw new HttpError(400, 'invalid_username');
  if (!emailRe.test(email)) throw new HttpError(400, 'invalid_email');
  if (!phoneRe.test(phone)) throw new HttpError(400, 'invalid_phone');
  if (password.length < 9) throw new HttpError(400, 'weak_password');
  if (password.length > 72) throw new HttpError(400, 'long_password');

  const taken = await User.findOne({ $or: [{ email }, { phone }, { username }] }).collation(collation);
  if (taken) throw new HttpError(409, 'exists');

  const user = new User({ username, email, phone, password: await bcrypt.hash(password, 10) });
  if (req.file) {
    const id = await saveFile(req.file.buffer, {
      name: 'avatar',
      mime: baseType(req.file),
      owner: user._id,
      purpose: 'avatar'
    });
    user.avatar = `/uploads/${id}`;
  }

  try {
    await user.save();
  } catch (error) {
    if (user.avatar) await removeFile(new mongoose.Types.ObjectId(user.avatar.split('/').pop()));
    if (error.code === 11000) throw new HttpError(409, 'exists');
    throw error;
  }
  sendSession(req, res, user);
});

app.post('/api/login', loginLimiter, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = await User.findOne({ email });
  const valid = await bcrypt.compare(password, user ? user.password : DUMMY_HASH);
  if (!user || !valid) throw new HttpError(401, 'invalid_credentials');
  sendSession(req, res, user);
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => sendSession(req, res, req.user));

app.get('/api/rooms', requireAuth, async (req, res) => {
  const me = req.user;
  const rooms = await populateMembers(
    Room.find({ $or: [{ type: 'public' }, { members: me._id }] }).sort({ createdAt: 1 })
  );
  const reads = await ReadState.find({ user: me._id, room: { $in: rooms.map(room => room._id) } });
  const readAt = new Map(reads.map(read => [read.room.toString(), read.lastReadAt]));

  const counts = await Promise.all(
    rooms.map(room =>
      Message.countDocuments({
        room: room._id,
        author: { $ne: me._id },
        createdAt: { $gt: readAt.get(room.id) || me.createdAt }
      })
    )
  );
  res.json(rooms.map((room, i) => serializeRoom(room, me.id, counts[i])));
});

const joinUsers = (room, userIds) => {
  userIds.forEach(id => {
    io.in(`user:${id}`).socketsJoin(`room:${room.id}`);
    io.to(`user:${id}`).emit('room:new', serializeRoom(room, id));
  });
};

app.post('/api/rooms/dm', requireAuth, async (req, res) => {
  const other = await User.findOne({ username: String(req.body.username || '').trim() }).collation(collation);
  if (!other) throw new HttpError(404, 'not_found');
  if (other.id === req.user.id) throw new HttpError(400, 'self');

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
  if (name.length < 2 || name.length > 30) throw new HttpError(400, 'invalid_name');

  const room = await Room.create({
    key: `group:${crypto.randomUUID()}`,
    name,
    type: 'group',
    members: [req.user._id],
    owner: req.user._id,
    inviteCode: newInviteCode()
  });
  joinUsers(room, [req.user.id]);
  res.json(serializeRoom(room, req.user.id));
});

app.post('/api/rooms/join', requireAuth, async (req, res) => {
  const code = String(req.body.code || '').trim();
  if (!code || code.length > 32) throw new HttpError(404, 'not_found');

  const room = await Room.findOneAndUpdate(
    { inviteCode: code, type: 'group' },
    { $addToSet: { members: req.user._id } },
    { new: true }
  );
  if (!room) throw new HttpError(404, 'not_found');
  joinUsers(room, [req.user.id]);
  res.json(serializeRoom(room, req.user.id));
});

app.post('/api/rooms/:id/leave', requireAuth, async (req, res) => {
  const room = await findRoom(req.params.id);
  const isMember = room && room.members.some(member => member.equals(req.user._id));
  if (!room || room.type !== 'group' || !isMember) throw new HttpError(404, 'not_found');

  room.members.pull(req.user._id);
  if (!room.members.length) {
    await destroyRoom(room);
  } else {
    if (!room.owner || room.owner.equals(req.user._id)) room.owner = room.members[0];
    await room.save();
    await ReadState.deleteOne({ user: req.user._id, room: room._id });
  }

  io.in(`user:${req.user.id}`).socketsLeave(`room:${room.id}`);
  io.to(`user:${req.user.id}`).emit('room:left', room.id);
  res.json({ ok: true });
});

app.get('/api/rooms/:id/messages', requireAuth, async (req, res) => {
  const room = await findRoom(req.params.id);
  if (!room || !canAccess(room, req.user._id)) throw new HttpError(404, 'not_found');

  const query = { room: room._id };
  const before = String(req.query.before || '');
  if (idRe.test(before)) query._id = { $lt: before };

  const found = await Message.find(query)
    .sort({ _id: -1 })
    .limit(PAGE_SIZE + 1)
    .populate('author', 'username avatar');
  res.json({
    messages: found.slice(0, PAGE_SIZE).reverse().map(serializeMessage),
    hasMore: found.length > PAGE_SIZE
  });
});

const uploadTarget = async (req, res, next) => {
  req.purpose = req.query.purpose === 'bg' ? 'bg' : 'message';
  if (req.purpose === 'message') {
    const room = await findRoom(req.query.room);
    if (!room || !canAccess(room, req.user._id)) throw new HttpError(404, 'not_found');
    req.targetRoom = room;
  }
  next();
};

app.post('/api/upload', requireAuth, uploadLimiter, uploadTarget, upload.single('file'), async (req, res) => {
  if (!req.file) throw new HttpError(400, 'upload_failed');
  const mime = baseType(req.file);
  if (req.purpose === 'bg' && (!mime.startsWith('image/') || req.file.size > 10 * MB)) {
    throw new HttpError(400, 'upload_failed');
  }

  const id = await saveFile(req.file.buffer, {
    name: req.file.originalname,
    mime,
    owner: req.user._id,
    room: req.targetRoom && req.targetRoom._id,
    purpose: req.purpose
  });
  res.json({ url: `/uploads/${id}` });
});

app.get('/api/emojis', requireAuth, (req, res) => res.json(emojiList));

app.get('/uploads/:id', requireFileAuth, async (req, res) => {
  const file = await findFile(req.params.id);
  if (!file) throw new HttpError(404, 'not_found');

  const { purpose, owner, room: roomId, mime } = file.metadata || {};
  let allowed = false;
  if (purpose === 'avatar') allowed = true;
  else if (purpose === 'bg') allowed = Boolean(owner) && owner.equals(req.user._id);
  else if (roomId) {
    const room = await Room.findById(roomId);
    allowed = Boolean(room) && canAccess(room, req.user._id);
  }
  if (!allowed) throw new HttpError(404, 'not_found');

  const size = file.length;
  let start = 0;
  let end = size - 1;
  let status = 200;

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    if (range[1] === '') {
      start = Math.max(size - Number(range[2]), 0);
    } else {
      start = Number(range[1]);
      if (range[2] !== '') end = Math.min(Number(range[2]), size - 1);
    }
    if (start > end || start >= size) {
      res.set('Content-Range', `bytes */${size}`);
      return res.status(416).end();
    }
    status = 206;
    res.set('Content-Range', `bytes ${start}-${end}/${size}`);
  }

  res.status(status).set({
    'Content-Type': mime || 'application/octet-stream',
    'Content-Length': size ? end - start + 1 : 0,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=86400',
    'X-Content-Type-Options': 'nosniff'
  });
  if (!size) return res.end();

  bucket
    .openDownloadStream(file._id, { start, end: end + 1 })
    .on('error', () => res.destroy())
    .pipe(res);
});

app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.code });
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'file_too_large' : 'upload_failed' });
  }
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
    return res.status(400).json({ error: 'generic' });
  }
  console.error(err);
  res.status(500).json({ error: 'generic' });
});


io.use(async (socket, next) => {
  const user = await userFromToken(socket.handshake.auth && socket.handshake.auth.token);
  if (!user) return next(new Error('unauthorized'));
  socket.user = user;
  next();
});

io.on('connection', async socket => {
  const { user } = socket;
  socket.join(`user:${user.id}`);

  const rooms = await Room.find({ $or: [{ type: 'public' }, { members: user._id }] }).select('_id');
  rooms.forEach(room => socket.join(`room:${room.id}`));

  const hits = [];
  const tooFast = () => {
    const now = Date.now();
    while (hits.length && hits[0] < now - 10000) hits.shift();
    if (hits.length >= 20) return true;
    hits.push(now);
    return false;
  };

  socket.on('message', async ({ roomId, kind, text, file } = {}) => {
    try {
      if (tooFast() || !messageKinds.includes(kind)) return;

      const room = await findRoom(roomId);
      if (!room || !canAccess(room, user._id)) return;

      const data = { room: room._id, author: user._id, kind };

      if (kind === 'text') {
        const clean = String(text || '').trim().slice(0, 2000);
        if (!clean) return;
        data.text = emoji.emojify(clean);
      } else {
        if (!filePattern.test(String(file))) return;
        const stored = await findFile(file.split('/').pop());
        const meta = stored && stored.metadata;
        const valid =
          meta &&
          meta.purpose === 'message' &&
          meta.owner.equals(user._id) &&
          meta.room &&
          meta.room.equals(room._id) &&
          String(meta.mime).startsWith(kindPrefix[kind]);
        if (!valid) return;
        data.file = file;
      }

      const message = await (await Message.create(data)).populate('author', 'username avatar');
      io.to(`room:${room.id}`).emit('message', serializeMessage(message));
    } catch (error) {
      console.error('message handler failed:', error);
    }
  });

  socket.on('read', async roomId => {
    try {
      if (tooFast()) return;
      const room = await findRoom(roomId);
      if (!room || !canAccess(room, user._id)) return;
      await ReadState.updateOne(
        { user: user._id, room: room._id },
        { $set: { lastReadAt: new Date() } },
        { upsert: true }
      );
    } catch (error) {
      if (error.code !== 11000) console.error('read handler failed:', error);
    }
  });
});

const legacyDir = path.join(__dirname, 'uploads');
const legacyUrl = /^\/uploads\/[\w-]+\.\w+$/;
const extToMime = {
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.webm': 'video/webm',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4'
};

const importLegacyFile = async (url, meta) => {
  const full = path.join(legacyDir, path.basename(url));
  const mime = extToMime[path.extname(full).toLowerCase()];
  if (!mime || !fs.existsSync(full)) return null;
  const finalMime = meta.kind === 'voice' && mime === 'video/webm' ? 'audio/webm' : mime;
  const id = await saveFile(fs.readFileSync(full), { name: path.basename(full), mime: finalMime, ...meta });
  return `/uploads/${id}`;
};

const importLegacyUploads = async () => {
  if (!fs.existsSync(legacyDir)) return;
  let moved = 0;

  for await (const user of User.find({ avatar: legacyUrl })) {
    const url = await importLegacyFile(user.avatar, { owner: user._id, purpose: 'avatar' });
    if (url) {
      user.avatar = url;
      await user.save();
      moved++;
    }
  }

  for await (const message of Message.find({ file: legacyUrl })) {
    const url = await importLegacyFile(message.file, {
      owner: message.author,
      room: message.room,
      purpose: 'message',
      kind: message.kind
    });
    if (url) {
      message.file = url;
      await message.save();
      moved++;
    }
  }
  if (moved) console.log(`Moved ${moved} legacy upload(s) into GridFS. The ./uploads folder can now be deleted.`);
};

const migrate = async () => {
  await Room.findOneAndUpdate(
    { key: 'general' },
    { $setOnInsert: { name: 'General', type: 'public' } },
    { upsert: true }
  );

  const plain = await User.find({ password: { $not: legacyHash } });
  for (const user of plain) {
    user.password = await bcrypt.hash(user.password, 10);
    await user.save();
  }
  if (plain.length) console.log(`Hashed ${plain.length} legacy plaintext password(s).`);

  await importLegacyUploads();

  const groups = await Room.find({ type: 'group', $or: [{ inviteCode: { $exists: false } }, { owner: { $exists: false } }] });
  for (const room of groups) {
    if (!room.inviteCode) room.inviteCode = newInviteCode();
    if (!room.owner && room.members.length) room.owner = room.members[0];
    await room.save();
  }
};

const PORT = Number(process.env.PORT) || 3000;

mongoose
  .connect(MONGO_URI)
  .then(async () => {
    bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'uploads' });
    await migrate();
    server.listen(PORT, () => console.log(`Server started on port ${PORT}`));
  })
  .catch(error => {
    console.error('Startup failed:', error.message);
    process.exit(1);
  });