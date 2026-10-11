import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '@/hooks/use-toast';
import { downloadFile, type StepExporter } from '@/utils/downloadUtils';

export type CadExportFormat = 'step' | 'stl' | 'py';

export type CadExportOptions = {
  currentOutput?: Blob;
  stepExporter?: StepExporter | null;
  stlExporter?: StepExporter | null;
  code?: string;
  filenameBase?: string;
};

/** Shared controller for legacy download controls and Iris Preview Export. */
export function useCadExport({
  currentOutput,
  stepExporter,
  stlExporter,
  code,
  filenameBase = 'parametric-model',
}: CadExportOptions) {
  const { toast } = useToast();
  const [selectedFormat, setSelectedFormat] = useState<CadExportFormat>('step');
  const [isExporting, setIsExporting] = useState(false);

  const formatAvailable = useMemo<Record<CadExportFormat, boolean>>(
    () => ({
      step: !!stepExporter && !isExporting,
      stl: (!!currentOutput || !!stlExporter) && !isExporting,
      py: !!code && !isExporting,
    }),
    [code, currentOutput, isExporting, stepExporter, stlExporter],
  );

  // STEP remains preferred whenever present; switch only when the selected
  // format cannot be exported by the current artifact (e.g. Assembly/STL).
  useEffect(() => {
    if (formatAvailable[selectedFormat]) return;
    const fallback: CadExportFormat | undefined = (
      ['step', 'stl', 'py'] as const
    ).find((format) => formatAvailable[format]);
    if (fallback) setSelectedFormat(fallback);
  }, [formatAvailable, selectedFormat]);

  const exportFormat = useCallback(
    async (format: CadExportFormat) => {
      if (!formatAvailable[format]) return;
      try {
        setIsExporting(true);
        if (format === 'step') {
          if (!stepExporter) return;
          downloadFile({
            content: await stepExporter(),
            filename: `${filenameBase}.step`,
          });
          return;
        }
        if (format === 'stl') {
          if (currentOutput) {
            downloadFile({
              content: currentOutput,
              filename: `${filenameBase}.stl`,
            });
            return;
          }
          if (!stlExporter) return;
          downloadFile({
            content: await stlExporter(),
            filename: `${filenameBase}.stl`,
          });
          return;
        }
        if (code)
          downloadFile({
            content: code,
            filename: `${filenameBase}.py`,
            mimeType: 'text/x-python',
          });
      } catch (error) {
        const label = format.toUpperCase();
        console.error(`[SimpleCADAPI] Failed to export ${label}:`, error);
        toast({
          title: `${label} export failed`,
          description:
            error instanceof Error
              ? error.message
              : `Iris could not export this model as ${label}.`,
          variant: 'destructive',
        });
      } finally {
        setIsExporting(false);
      }
    },
    [
      code,
      currentOutput,
      filenameBase,
      formatAvailable,
      stepExporter,
      stlExporter,
      toast,
    ],
  );

  const isAnyFormatAvailable = Object.values(formatAvailable).some(Boolean);

  return {
    selectedFormat,
    setSelectedFormat,
    isExporting,
    formatAvailable,
    isAnyFormatAvailable,
    exportFormat,
    exportSelected: () => exportFormat(selectedFormat),
  };
}
