# Liber

Liber is a Node.js chat app with direct messages, group rooms, image and voice messages, and MongoDB storage.

## Requirements

- Node.js 20 or newer
- MongoDB 6 or newer, available through `MONGO_URI`

## Run locally

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env`.
3. Set `MONGO_URI` to a MongoDB connection string.
4. Set `JWT_SECRET` to a private random value. For example, run `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` and copy the result.
5. Set `TRUST_PROXY=1` only when the app is behind one trusted reverse proxy. Use `0` for direct local access.
6. Start the app with `npm start` and open `http://localhost:3000`.

`PORT` is optional; the default is `3000`. The app creates the public room on startup. User uploads are stored in MongoDB GridFS. Existing files in the local `uploads` directory are moved to GridFS during startup when their database records still reference them.

## Deploy

Set `MONGO_URI` and `JWT_SECRET` in the service's environment settings. Set `PORT` only if the host does not provide it. Set `TRUST_PROXY` to the number of trusted proxy hops in front of the service. Keep `.env` private and do not commit it.

Group owners can show or rotate an invite code from the room header. Members can join with that code and leave a group from the same header. A departing owner transfers ownership to the next member.
