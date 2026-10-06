import { configureTextEncoding, getTextEncoding } from "@bufbuild/protobuf/wire";

const encoding = getTextEncoding();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const strictDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// A protobuf string carries content, so an initial U+FEFF must survive the wire.
configureTextEncoding({
  ...encoding,
  decodeUtf8: (bytes, strict) => (strict ? strictDecoder : decoder).decode(bytes)
});
