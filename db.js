const mongoose = require('mongoose');

// ─── CONEXIÓN ─────────────────────────────────────────────────────────────────
async function connectDB() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('MongoDB conectado.');
}

// ─── ESQUEMAS ─────────────────────────────────────────────────────────────────
const sessionSchema = new mongoose.Schema({
  userId:   { type: String, required: true, unique: true },
  username: String,
  start:    Number,
});

const historySchema = new mongoose.Schema({
  userId:   { type: String, required: true, unique: true },
  username: String,
  totalMs:  { type: Number, default: 0 },
  sessions: [{
    start:    Number,
    end:      Number,
    duration: Number,
  }],
});

const sancionSchema = new mongoose.Schema({
  userId:    { type: String, required: true, unique: true },
  sanciones: [{
    motivo: String,
    fecha:  Number,
    por:    String,
  }],
});

const pendingSchema = new mongoose.Schema({
  userId:    { type: String, required: true, unique: true },
  channelId: String,
  messageId: String,
});

// ─── MODELOS ──────────────────────────────────────────────────────────────────
const Session  = mongoose.model('Session',  sessionSchema);
const History  = mongoose.model('History',  historySchema);
const Sancion  = mongoose.model('Sancion',  sancionSchema);
const Pending  = mongoose.model('Pending',  pendingSchema);

module.exports = { connectDB, Session, History, Sancion, Pending };
