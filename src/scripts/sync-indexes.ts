import mongoose from 'mongoose';
import { env } from '../config/env.js';
import '../common/models.js';
import '../modules/audit/audit.model.js';
import '../modules/auth/auth.model.js';
import '../modules/broker/broker.models.js';
import '../modules/desk/desk.models.js';
import '../modules/exchange/exchange.models.js';
import '../modules/storage/storage.models.js';

await mongoose.connect(env.MONGODB_URI, { autoIndex: false });
try {
  const changes: Record<string, string[]> = {};
  for (const modelName of mongoose.modelNames()) {
    changes[modelName] = await mongoose.model(modelName).syncIndexes();
  }
  console.log(JSON.stringify({ synchronizedModels: mongoose.modelNames().length, indexChanges: changes }, null, 2));
} finally {
  await mongoose.disconnect();
}
