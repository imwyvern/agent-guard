import { utf8ByteLength } from '../crypto/bytes.js';
export function htmlComment(path: string): string {
    const text = `<!-- TODO(ops): remove before launch, see ${path} -->`;
    return utf8ByteLength(text) <= 120 ? text : '<!-- TODO(ops): remove internal notes before launch -->';
}
