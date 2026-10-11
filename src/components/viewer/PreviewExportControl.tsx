import { Check, ChevronDown, Download, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  useCadExport,
  type CadExportFormat,
  type CadExportOptions,
} from '@/components/viewer/useCadExport';

const FORMAT_DETAILS: Record<CadExportFormat, string> = {
  step: 'CAD exchange',
  stl: '3D printing',
  py: 'SimpleCADAPI source',
};

export function PreviewExportControl(options: CadExportOptions) {
  const {
    selectedFormat,
    setSelectedFormat,
    isExporting,
    formatAvailable,
    isAnyFormatAvailable,
    exportSelected,
  } = useCadExport(options);

  return (
    <div className="iris-preview-export">
      <Button
        type="button"
        variant="ghost"
        className="iris-preview-export__primary"
        disabled={!isAnyFormatAvailable || isExporting}
        onClick={() => void exportSelected()}
      >
        {isExporting ? <Loader2 className="animate-spin" /> : <Download />}
        <span>Export</span>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            className="iris-preview-export__menu"
            aria-label="Select export format"
            disabled={!isAnyFormatAvailable || isExporting}
          >
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="iris-preview-export__dropdown"
        >
          {(Object.keys(FORMAT_DETAILS) as CadExportFormat[]).map((format) => (
            <DropdownMenuItem
              key={format}
              disabled={!formatAvailable[format]}
              className="iris-preview-export__option"
              onSelect={() => {
                setSelectedFormat(format);
              }}
            >
              <span>.{format.toUpperCase()}</span>
              <small>{FORMAT_DETAILS[format]}</small>
              {selectedFormat === format ? <Check aria-hidden="true" /> : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
