// Silent no-op toast - all toast calls do nothing but don't cause errors
const noOpResult = {
  id: "0",
  dismiss: () => {},
  update: () => {},
};

function toast(_props?: any) {
  return noOpResult;
}

function useToast() {
  return {
    toasts: [],
    toast,
    dismiss: () => {},
  };
}

export { useToast, toast };
