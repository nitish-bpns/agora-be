import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { User } from '../modules/auth/auth.model.js';

await mongoose.connect(env.MONGODB_URI, { autoIndex: false });
try {
  const database = mongoose.connection.db;
  if (!database) throw new Error('MongoDB is not connected');
  const collectionNames = (await database.listCollections({}, { nameOnly: true }).toArray()).map((item) => item.name);
  const forbidden = ['operators', 'traders', 'tradersessions'].filter((name) => collectionNames.includes(name));
  if (forbidden.length) throw new Error(`Legacy identity collections still exist: ${forbidden.join(', ')}`);

  const users = await User.find().select('+passwordHash').sort({ userType: 1, username: 1 });
  for (const user of users) {
    if (!user.passwordHash) throw new Error(`User ${user.username} has no password hash`);
    if (user.userType === 'Trader' && (!user.accountId || user.role !== 'Trader')) throw new Error(`Trader ${user.username} is missing its account or role`);
    if (user.userType !== 'Trader' && user.accountId) throw new Error(`Non-trader ${user.username} unexpectedly owns a trading account`);
  }

  const byType = Object.fromEntries(['Trader', 'Broker', 'Exchange', 'Storage'].map((type) => [type, users.filter((user) => user.userType === type).length]));
  console.log(JSON.stringify({ users: users.length, byType, identityCollections: ['users', 'usersessions'] }, null, 2));
} finally {
  await mongoose.disconnect();
}
