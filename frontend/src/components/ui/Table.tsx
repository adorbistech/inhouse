interface Column<T> {
  header: string;
  render: (row: T) => React.ReactNode;
  className?: string;
}

interface TableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  className?: string;
}

export function Table<T>({ columns, rows, rowKey, className = "" }: TableProps<T>) {
  return (
    <div className={`overflow-x-auto ${className}`}>
      <table className="w-full border-collapse min-w-[560px]">
        <thead>
          <tr className="bg-surface-container-high">
            {columns.map((col) => (
              <th
                key={col.header}
                className="font-label-md text-label-md text-on-surface-variant uppercase text-left px-space-sm py-space-xs border-b border-primary"
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className="bg-surface hover:bg-surface-container-low border-b border-outline-variant transition-colors">
              {columns.map((col) => (
                <td key={col.header} className={`font-body-md text-body-md px-space-sm py-space-xs ${col.className ?? ""}`}>
                  {col.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
