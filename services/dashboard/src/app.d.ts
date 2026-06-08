declare module "$env/static/public" {
  export const PUBLIC_APP_VERSION: string;
}

declare global {
  namespace App {
    interface Locals {
      user: {
        id: string;
        email: string;
        name: string;
      } | null;
      session: {
        id: string;
        userId: string;
        expiresAt: Date;
      } | null;
    }
  }
}

export {};
