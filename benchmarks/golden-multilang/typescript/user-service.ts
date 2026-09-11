export interface User {
  id: string;
  name: string;
}

export class UserService {
  public findUserById(id: string): User | undefined {
    return id.length > 0 ? { id, name: "local" } : undefined;
  }

  public validateAccessToken(token: string): boolean {
    return token.startsWith("access-");
  }
}
