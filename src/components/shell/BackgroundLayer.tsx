import { useEffect } from "react";
import { usePreferences } from "@/hooks/usePreferences";
import { useThemeSettings } from "@/hooks/useThemeSettings";
import {
  applyBackgroundCache,
  buildBackgroundCache,
  persistBackgroundCache,
} from "@/utils/background";

/** 同步背景 CSS 变量和首帧缓存；实际背景由 body 伪元素绘制。 */
export function BackgroundLayer() {
  const { farmScene } = usePreferences();
  const {
    enableBackgroundImage,
    backgroundImageInFarm,
    backgroundImage,
    backgroundImageMobile,
    backgroundAlignment,
    surfaceOpacity,
    isReady,
  } = useThemeSettings();

  useEffect(() => {
    if (!isReady) return;
    const cache = buildBackgroundCache({
      enableBackgroundImage,
      backgroundImageInFarm,
      backgroundImage,
      backgroundImageMobile,
      backgroundAlignment,
      surfaceOpacity,
    });
    persistBackgroundCache(cache);
    applyBackgroundCache(cache, farmScene);
  }, [
    isReady,
    enableBackgroundImage,
    backgroundImageInFarm,
    backgroundImage,
    backgroundImageMobile,
    backgroundAlignment,
    surfaceOpacity,
    farmScene,
  ]);

  return null;
}
