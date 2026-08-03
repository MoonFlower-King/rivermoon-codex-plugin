import { mkdir } from "node:fs/promises";
import path from "node:path";
import { JSONFilePreset } from "lowdb/node";

export interface OAuthClient {
  clientId: string;
  redirectUris: string[];
  createdAt: number;
}

export interface PendingAuthorization {
  id: string;
  clientId: string;
  redirectUri: string;
  state?: string;
  scope: string;
  resource: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  createdAt: number;
  encryptedNewApiSession?: string;
}

export interface AuthorizationCode {
  codeHash: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  resource: string;
  codeChallenge: string;
  userId: number;
  username: string;
  encryptedNewApiSession: string;
  encryptedStandardKey: string;
  encryptedProKey: string;
  expiresAt: number;
}

export interface AccessGrant {
  tokenHash: string;
  clientId: string;
  scope: string;
  resource: string;
  userId: number;
  username: string;
  encryptedNewApiSession: string;
  encryptedStandardKey: string;
  encryptedProKey: string;
  expiresAt: number;
}

export interface RefreshGrant extends Omit<AccessGrant, "tokenHash" | "expiresAt"> {
  tokenHash: string;
  expiresAt: number;
}

interface DatabaseShape {
  clients: Record<string, OAuthClient>;
  pending: Record<string, PendingAuthorization>;
  codes: Record<string, AuthorizationCode>;
  accessTokens: Record<string, AccessGrant>;
  refreshTokens: Record<string, RefreshGrant>;
}

const EMPTY_DATABASE: DatabaseShape = {
  clients: {},
  pending: {},
  codes: {},
  accessTokens: {},
  refreshTokens: {},
};

export class GatewayStore {
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly db: Awaited<ReturnType<typeof JSONFilePreset<DatabaseShape>>>,
  ) {}

  static async open(filename: string): Promise<GatewayStore> {
    await mkdir(path.dirname(filename), { recursive: true });
    const db = await JSONFilePreset<DatabaseShape>(filename, structuredClone(EMPTY_DATABASE));
    return new GatewayStore(db);
  }

  private async mutate(fn: (data: DatabaseShape) => void): Promise<void> {
    const run = async () => {
      fn(this.db.data);
      await this.db.write();
    };
    this.writeQueue = this.writeQueue.then(run, run);
    await this.writeQueue;
  }

  async putClient(client: OAuthClient): Promise<void> {
    await this.mutate((data) => {
      data.clients[client.clientId] = client;
    });
  }

  getClient(clientId: string): OAuthClient | undefined {
    return this.db.data.clients[clientId];
  }

  async putPending(value: PendingAuthorization): Promise<void> {
    await this.mutate((data) => {
      data.pending[value.id] = value;
    });
  }

  getPending(id: string): PendingAuthorization | undefined {
    return this.db.data.pending[id];
  }

  async updatePending(id: string, patch: Partial<PendingAuthorization>): Promise<void> {
    await this.mutate((data) => {
      const current = data.pending[id];
      if (current) data.pending[id] = { ...current, ...patch };
    });
  }

  async deletePending(id: string): Promise<void> {
    await this.mutate((data) => {
      delete data.pending[id];
    });
  }

  async putCode(value: AuthorizationCode): Promise<void> {
    await this.mutate((data) => {
      data.codes[value.codeHash] = value;
    });
  }

  async consumeCode(codeHash: string): Promise<AuthorizationCode | undefined> {
    let result: AuthorizationCode | undefined;
    await this.mutate((data) => {
      result = data.codes[codeHash];
      delete data.codes[codeHash];
    });
    return result;
  }

  async putAccessToken(value: AccessGrant): Promise<void> {
    await this.mutate((data) => {
      data.accessTokens[value.tokenHash] = value;
    });
  }

  getAccessToken(tokenHash: string): AccessGrant | undefined {
    const grant = this.db.data.accessTokens[tokenHash];
    return grant && grant.expiresAt > Date.now() ? grant : undefined;
  }

  async putRefreshToken(value: RefreshGrant): Promise<void> {
    await this.mutate((data) => {
      data.refreshTokens[value.tokenHash] = value;
    });
  }

  async consumeRefreshToken(tokenHash: string): Promise<RefreshGrant | undefined> {
    let result: RefreshGrant | undefined;
    await this.mutate((data) => {
      result = data.refreshTokens[tokenHash];
      delete data.refreshTokens[tokenHash];
    });
    if (!result || result.expiresAt <= Date.now()) return undefined;
    return result;
  }

  async revokeToken(tokenHash: string): Promise<void> {
    await this.mutate((data) => {
      delete data.accessTokens[tokenHash];
      delete data.refreshTokens[tokenHash];
    });
  }

  async prune(): Promise<void> {
    const now = Date.now();
    await this.mutate((data) => {
      for (const [id, pending] of Object.entries(data.pending)) {
        if (pending.createdAt + 10 * 60_000 <= now) delete data.pending[id];
      }
      for (const [hash, code] of Object.entries(data.codes)) {
        if (code.expiresAt <= now) delete data.codes[hash];
      }
      for (const [hash, token] of Object.entries(data.accessTokens)) {
        if (token.expiresAt <= now) delete data.accessTokens[hash];
      }
      for (const [hash, token] of Object.entries(data.refreshTokens)) {
        if (token.expiresAt <= now) delete data.refreshTokens[hash];
      }
    });
  }
}
