const STEPS = ['Start', 'Browser', 'Setup', 'Room'];

export function StepRail({ current }: { current: number }) {
  return (
    <div
      className="flex items-center gap-1.5"
      role="group"
      aria-label={`Step ${current + 1} of ${STEPS.length}`}
    >
      <span className="sr-only">
        Step {current + 1} of {STEPS.length}, {STEPS[current]}
      </span>
      {STEPS.map((label, index) => (
        <span
          key={label}
          aria-hidden="true"
          className={
            index === current
              ? 'h-1.5 w-4 rounded-full bg-foreground'
              : index < current
                ? 'h-1.5 w-1.5 rounded-full bg-muted-foreground'
                : 'h-1.5 w-1.5 rounded-full bg-border'
          }
        />
      ))}
    </div>
  );
}
