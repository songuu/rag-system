import type { PPTAnimation, SlidePage, SceneAction } from './types';

const DEFAULT_ANIMATION_DURATION = 650;

export function getSlideDescriptionElementId(slideIndex: number): string {
  return `slide-${slideIndex}-description`;
}

export function getSlidePointElementId(slideIndex: number, pointIndex: number): string {
  return `slide-${slideIndex}-point-${pointIndex}`;
}

export function buildDefaultSlideAnimations(
  slideIndex: number,
  pointCount: number
): PPTAnimation[] {
  const safePointCount = Math.max(0, Math.min(pointCount, 4));
  const animations: PPTAnimation[] = [
    {
      id: `anim_slide_${slideIndex}_description`,
      elId: getSlideDescriptionElementId(slideIndex),
      effect: 'fade',
      type: 'in',
      duration: 450,
      trigger: 'auto',
    },
  ];

  for (let pointIndex = 0; pointIndex < safePointCount; pointIndex += 1) {
    animations.push({
      id: `anim_slide_${slideIndex}_point_${pointIndex}`,
      elId: getSlidePointElementId(slideIndex, pointIndex),
      effect: pointIndex === 0 ? 'spotlight' : pointIndex === 1 ? 'laser' : 'fade-up',
      type: pointIndex < 2 ? 'attention' : 'in',
      duration: DEFAULT_ANIMATION_DURATION,
      trigger: pointIndex === 0 ? 'auto' : 'meantime',
    });
  }

  return animations;
}

export function getSlideAnimations(page: SlidePage, pointCount: number): PPTAnimation[] {
  return page.animations?.length
    ? page.animations
    : buildDefaultSlideAnimations(page.index, pointCount);
}

export function getSlidePointAnimation(
  page: SlidePage,
  pointIndex: number,
  pointCount: number
): PPTAnimation {
  const animations = getSlideAnimations(page, pointCount);
  const targetId = getSlidePointElementId(page.index, pointIndex);
  const fallbackAnimations = buildDefaultSlideAnimations(page.index, pointCount);
  return (
    animations.find(animation => animation.elId === targetId) ??
    animations[pointIndex + 1] ??
    animations[pointIndex] ??
    fallbackAnimations[pointIndex + 1] ??
    fallbackAnimations[0]
  );
}

export function isFireAndForgetAction(action: SceneAction): boolean {
  return action.type === 'spotlight' || action.type === 'laser';
}
