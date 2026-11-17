// Read a local file as base64 (without the data: prefix) for JSON upload. No server-side multipart needed.
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

export function readFileBase64(file) {
  if (file.size > MAX_UPLOAD_BYTES) return Promise.reject(new Error('파일은 8MB 이하만 올릴 수 있습니다.'));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '');
    reader.onerror = () => reject(new Error('파일을 읽지 못했습니다. 다시 선택해주세요.'));
    reader.readAsDataURL(file);
  });
}
