import { Toaster as Sonner, toast as sonnerToast, type ExternalToast } from "sonner";
import { useTheme } from "@/contexts/ThemeContext";

type ToasterProps = React.ComponentProps<typeof Sonner>;

/**
 * The app's one toaster (standard 1 + GET-599, interface refresh): bottom right, dark ink in
 * both themes, 5 seconds, and always a next action where there is one (View task / Undo, Open
 * draft, Try again). Errors stay until dismissed — a failure that disappears on its own is a
 * failure nobody read.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  const { theme } = useTheme();
  return (
    <Sonner
      theme={theme}
      position="bottom-right"
      duration={5000}
      offset={16}
      gap={8}
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            "group toast !w-[320px] !items-start !gap-2.5 !rounded-xl !border-0 !px-3 !py-[11px] !text-[13px] " +
            "group-[.toaster]:!bg-[#1A1A18] group-[.toaster]:!text-white group-[.toaster]:!shadow-[0_12px_28px_-10px_rgba(20,20,18,0.45),0_2px_6px_rgba(20,20,18,0.12)] " +
            "dark:group-[.toaster]:!bg-[#2A2A27]",
          title: "!font-medium",
          description: "!mt-px !text-xs !text-[#B3B2AC]",
          actionButton:
            "!h-auto !rounded-md !bg-transparent !px-1.5 !py-0.5 !text-xs !font-medium !text-white hover:!bg-white/10",
          cancelButton: "!bg-transparent !text-xs !text-[#B3B2AC]",
          closeButton: "!border-0 !bg-[#3A3A37] !text-[#B3B2AC]",
          icon: "!mt-px",
        },
      }}
      {...props}
    />
  );
};

type Message = Parameters<typeof sonnerToast>[0];

/** sonner's toast, with errors that stay until dismissed and carry a close button. */
const toast = Object.assign((message: Message, data?: ExternalToast) => sonnerToast(message, data), sonnerToast, {
  error: (message: Message, data?: ExternalToast) => sonnerToast.error(message, { duration: Infinity, closeButton: true, ...data }),
});

export { Toaster, toast };
