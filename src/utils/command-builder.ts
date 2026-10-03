export type CommandSegments = (
  | string
  | CommandSegments
  | {
      _rawString_: string;
    }
)[];

const sanitize = (str: string) => {
  if (str.includes("\0"))
    throw new Error("NUL is not allowed in command arguments");
  return /^[A-Za-z0-9_./:=+-]+$/.test(str)
    ? str
    : "'" + str.replaceAll("'", "'\\''") + "'";
};

export function build(
  command: CommandSegments,
  env?: { [key: string]: string }
): string {
  const ret =
    Object.entries(env ?? {})
      .map(([key, value]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
          throw new Error("Invalid environment variable name");
        if (!value) {
          return "";
        }
        return `${key}=${sanitize(value)} `; // I can trust key has no space right?
      })
      .join("") +
    command
      .map(segment => {
        if (segment instanceof Array) {
          return `$(${build(segment)})`; // TODO: special handling
        } else if (typeof segment == "string") {
          return sanitize(segment);
        } else {
          return segment._rawString_;
        }
      })
      .join(" ");
  return ret;
}

export function rawString(str: string) {
  return {
    _rawString_: str,
  };
}
