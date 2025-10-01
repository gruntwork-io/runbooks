import { cva } from "class-variance-authority"

// This cva function creates a typed variant system that can be used with VariantProps
// The variants object defines all possible values for each prop (variant, size)
// VariantProps<typeof buttonVariants> extracts these as TypeScript types for IDE autocomplete
//
// In practice, use your IDE autocomplete to see all possible values for variant and size.
export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive cursor-pointer active:shadow-xs active:translate-y-0.5",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90 border border-primary/20 shadow-sm",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 border border-destructive/20 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 shadow-sm",
        outline:
          "border border-border bg-background hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50 shadow-sm",
        secondary:
          "bg-secondary text-secondary-foreground/50 hover:bg-secondary/80 border border-secondary/20 shadow-sm",
        ghost:
          "hover:text-accent-foreground shadow-none hover:shadow-none",
        link: "text-primary underline-offset-4 hover:underline shadow-none hover:shadow-none active:shadow-none",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)
