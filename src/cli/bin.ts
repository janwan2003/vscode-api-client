import { main } from './main.ts';

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`plainwire: ${(e as Error).stack ?? e}\n`);
    process.exitCode = 2;
  },
);
