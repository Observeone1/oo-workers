const stamp = () => new Date().toISOString();

export const logger = {
  info: (msg: string) => console.log(`${stamp()} [info]  ${msg}`),
  warn: (msg: string) => console.warn(`${stamp()} [warn]  ${msg}`),
  error: (msg: string) => console.error(`${stamp()} [error] ${msg}`),
};
