type Props = {
  quantity: number;
  onDecrement: () => void;
  onIncrement: () => void;
};

export function QuantityStepper({ quantity, onDecrement, onIncrement }: Props) {
  return (
    <div className="inline-flex items-center rounded-lg border border-stone-200">
      <button
        onClick={onDecrement}
        aria-label="Decrease quantity"
        className="px-3 py-1 text-lg text-stone-600 hover:bg-stone-100"
      >
        −
      </button>
      <span className="min-w-[2ch] text-center text-sm font-medium text-stone-800">{quantity}</span>
      <button
        onClick={onIncrement}
        aria-label="Increase quantity"
        className="px-3 py-1 text-lg text-stone-600 hover:bg-stone-100"
      >
        +
      </button>
    </div>
  );
}
