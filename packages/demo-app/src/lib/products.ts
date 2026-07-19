export type Product = {
  id: string;
  name: string;
  price: number;
  blurb: string;
  emoji: string;
  category: string;
};

export const PRODUCTS: Product[] = [
  { id: "wool-throw", name: "Wool Throw Blanket", price: 90, blurb: "Handwoven merino in oatmeal.", emoji: "🧶", category: "Living" },
  { id: "ceramic-mug-set", name: "Ceramic Mug (set of 2)", price: 60, blurb: "Stoneware, dishwasher safe.", emoji: "☕", category: "Kitchen" },
  { id: "linen-napkins", name: "Linen Napkins (set of 4)", price: 38, blurb: "Soft washed linen, sage.", emoji: "🌿", category: "Kitchen" },
  { id: "brass-candle", name: "Brass Candleholder", price: 72, blurb: "Solid brass, holds tapers.", emoji: "🕯️", category: "Living" },
  { id: "leather-journal", name: "Leather Journal", price: 44, blurb: "Refillable, 240 pages.", emoji: "📓", category: "Desk" },
  { id: "glass-carafe", name: "Glass Carafe", price: 34, blurb: "Mouth-blown, 1 liter.", emoji: "🫗", category: "Kitchen" },
];
