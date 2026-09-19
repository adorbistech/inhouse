export interface DbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  schema: string;
  poolMin: number;
  poolMax: number;
  ssl: boolean;
}
