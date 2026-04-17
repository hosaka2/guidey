/** BE との疎通確認 (settings 画面のテスト接続等で使用)。 */
export async function testConnection(apiUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${apiUrl}/health`);
    return res.ok;
  } catch {
    return false;
  }
}
