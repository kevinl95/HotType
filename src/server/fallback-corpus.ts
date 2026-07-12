export type BundledFallbackPassage = {
  id: string;
  title: string;
  body: string;
  score: number;
};

export const BUNDLED_FALLBACK_PASSAGES: readonly BundledFallbackPassage[] = [
  {
    id: "fallback-quiet-walk",
    title: "The walk that resets a long afternoon",
    body:
      "When I get stuck on a problem I take the same ten minute walk around the block and let my thoughts settle into a quieter order. I do not try to solve anything while I am moving. I just notice the trees, the traffic, and the open windows. By the time I get back to my desk the next step usually feels small enough to start.",
    score: 0,
  },
  {
    id: "fallback-kitchen-ritual",
    title: "A small kitchen ritual before work",
    body:
      "Every morning starts with the same sequence in my kitchen. I fill the kettle, grind the beans, and clear yesterday's notes from the table before the water boils. None of it is impressive, but the routine matters because it makes the first hour feel claimed in advance. By the time the mug is warm in my hands, the day already has a shape.",
    score: 0,
  },
  {
    id: "fallback-library-chair",
    title: "Finding the right chair in the library",
    body:
      "There is one chair on the second floor of the library that faces a window and never squeaks when I lean back. I do not think better in that chair, but I stay with hard pages longer because I am not distracted by tiny irritations. Comfort is not a luxury when you are trying to learn something difficult. It is often the difference between stopping early and staying curious.",
    score: 0,
  },
  {
    id: "fallback-recipe-margin",
    title: "The notes in the margin of a recipe",
    body:
      "My favorite cookbook has penciled notes in the margins from three different people. One person added more ginger, another lowered the heat, and a third wrote that the soup tastes better the next day after the salt has time to settle in. I trust those little marks more than the printed instructions because they sound like experience speaking plainly after the first attempt.",
    score: 0,
  },
  {
    id: "fallback-evening-window",
    title: "The quiet at the end of the evening",
    body:
      "Late in the evening the apartment changes character. The hallway goes still, the sink is finally empty, and the noise from the street turns into a softer background hum. That is when I can read a page twice without noticing the effort. Nothing dramatic happens in that hour. It is simply easier to pay attention when the room no longer asks anything else from me.",
    score: 0,
  },
  {
    id: "fallback-patch-notes",
    title: "Keeping better notes after a long session",
    body:
      "I used to end a long work session by closing every tab and promising myself I would remember where to start tomorrow. Now I leave one short note about what changed, what still feels wrong, and what I should verify first when I come back. The note is rarely elegant, but it saves me from spending the next morning rebuilding context that I already earned the night before.",
    score: 0,
  },
];