export const storySteps = [
  { at: 0, action: 'prepare', label: 'A capsule for a future premiere' },
  ...Array.from({ length: 20 }, (_, index) => ({
    at: 3000 + index * 1000,
    action: 'seal',
    index,
    label: 'A viewer seals a prediction',
  })),
  { at: 26000, action: 'lock', label: 'Twenty predictions sealed away' },
  {
    at: 30000,
    action: 'time',
    label: 'One week later… still waiting off stream',
  },
  {
    at: 38000,
    action: 'live',
    label: 'The stream goes live in another category',
  },
  {
    at: 45000,
    action: 'category',
    label: 'First stream in Grand Theft Auto VI',
  },
  {
    at: 58000,
    action: 'approve',
    label: 'Moderation approves the reveal highlights',
  },
  { at: 60000, action: 'reveal', label: 'The first prediction returns' },
  { at: 64000, action: 'reveal', label: 'Another message from the past' },
  {
    at: 68000,
    action: 'reveal',
    label: 'Three cards, with the game still visible',
  },
  {
    at: 72000,
    action: 'prophet',
    label: 'A prediction came true. Fake VIP granted!',
  },
  { at: 82000, action: 'end', label: 'The ceremony ends; the overlay clears' },
  {
    at: 90000,
    action: 'complete',
    label: 'The Wall of Prophets preserves the moment',
  },
] as const;
export const storyDurationMs = 90_000;
