import type { Stage1Input, Stage1Output, Stage1Runner } from "./types";

/**
 * クラウド経路: モバイルでは何もしない。BE 側の stage1 ノードが走る。
 * null を返すことで呼び出し側が "stage1_result を添えない" = 従来通りの動作になる。
 */
export class CloudStage1Runner implements Stage1Runner {
  isReady(): boolean {
    return true;
  }

  async prepare(): Promise<void> {
    /* no-op */
  }

  async run(_input: Stage1Input): Promise<Stage1Output | null> {
    return null;
  }

  async dispose(): Promise<void> {
    /* no-op */
  }
}
