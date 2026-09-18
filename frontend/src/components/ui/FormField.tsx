interface FormFieldProps {
  label: string;
  children: React.ReactNode;
  className?: string;
}

export function FormField({ label, children, className = "" }: FormFieldProps) {
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <label className="font-code-dense text-code-dense text-on-surface-variant uppercase">{label}</label>
      {children}
    </div>
  );
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { className = "", ...rest } = props;
  return (
    <input
      className={`bg-surface text-on-surface font-body-sm text-body-sm p-space-sm outline-none border border-outline-variant focus:border-primary placeholder:text-outline-variant ${className}`}
      {...rest}
    />
  );
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const { className = "", children, ...rest } = props;
  return (
    <select
      className={`bg-surface text-on-surface font-body-sm text-body-sm p-space-sm outline-none border border-outline-variant focus:border-primary ${className}`}
      {...rest}
    >
      {children}
    </select>
  );
}
