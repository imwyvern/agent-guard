export function htmlComment(path: string): string {
    const text = `<!-- TODO(ops): remove before launch, see ${path} -->`;
    return Buffer.byteLength(text) <= 120 ? text : '<!-- TODO(ops): remove internal notes before launch -->';
}
