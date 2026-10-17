declare global {
  namespace Express {
    interface Request {
      auth?: {
        subject: string;
        kind: 'operator' | 'trader';
        realm: 'Desk' | 'Broker' | 'Exchange' | 'Storage';
        role: 'Admin' | 'Operations' | 'Read-only' | 'Trader';
        accountId?: string;
        traderId?: string;
      };
    }
  }
}

export {};
