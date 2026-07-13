export interface WidgetRecord {
  id: string;
  label: string;
}

export class WidgetService {
  list(): WidgetRecord[] {
    return [{ id: "alpha", label: "Alpha" }];
  }
}

export function listWidgets(): WidgetRecord[] {
  return new WidgetService().list();
}

export function unusedWidgetHelper(value: string): string {
  return value.trim();
}
