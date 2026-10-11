import { createFileRoute } from '@tanstack/react-router';
import { IrisLayout } from '@/components/iris/IrisLayout';

export const Route = createFileRoute('/_layout')({
  component: IrisLayout,
});
