const required = ['MONGODB_URI', 'JWT_ACCESS_SECRET'];
if (process.env.VERCEL === '1') {
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) {
    console.error(`Missing required Vercel environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
  if ((process.env.JWT_ACCESS_SECRET ?? '').length < 32) {
    console.error('JWT_ACCESS_SECRET must contain at least 32 characters.');
    process.exit(1);
  }
}
