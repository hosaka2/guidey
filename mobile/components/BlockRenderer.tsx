import { View } from "@tamagui/core";
import type { Block } from "@/types/blocks";
import { TextBlockView } from "./blocks/TextBlockView";
import { ImageBlockView } from "./blocks/ImageBlockView";
import { VideoBlockView } from "./blocks/VideoBlockView";
import { TimerBlockView } from "./blocks/TimerBlockView";
import { AlertBlockView } from "./blocks/AlertBlockView";

function renderBlock(block: Block) {
  switch (block.type) {
    case "text":
      return <TextBlockView block={block} />;
    case "image":
      return <ImageBlockView block={block} />;
    case "video":
      return <VideoBlockView block={block} />;
    case "timer":
      return <TimerBlockView block={block} />;
    case "alert":
      return <AlertBlockView block={block} />;
    default:
      return null;
  }
}

export function BlockRenderer({ blocks }: { blocks: Block[] }) {
  if (!blocks || blocks.length === 0) return null;

  return (
    <View gap="$2">
      {blocks.map((block, i) => (
        <View key={`${block.type}-${i}`}>{renderBlock(block)}</View>
      ))}
    </View>
  );
}
