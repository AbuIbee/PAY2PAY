export interface SmsSender {
  send(input: { to: string; body: string }): Promise<void>;
}
