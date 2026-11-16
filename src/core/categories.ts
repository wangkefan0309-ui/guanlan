import { z } from 'zod';
import { categoryIdSchema, topicLabels, topics, legacyTopics } from './model';

export const categorySchema = z.object({ id: categoryIdSchema, name: z.string().trim().min(1).max(60), topic: z.enum(topics) }).strict();
export type SourceCategory = z.infer<typeof categorySchema>;
export const defaultCategories = (): SourceCategory[] => topics.map(topic => ({ id: topic, name: topicLabels[topic], topic }));
export const categoriesSchema = z.array(categorySchema).min(legacyTopics.length).max(100).superRefine((categories, context) => {
  if (new Set(categories.map(category => category.id)).size !== categories.length) context.addIssue({ code: 'custom', message: '分类标识重复' });
  if (new Set(categories.map(category => category.name.normalize('NFKC').toLocaleLowerCase())).size !== categories.length) context.addIssue({ code: 'custom', message: '分类名称重复' });
  if (legacyTopics.some(topic => !categories.some(category => category.id === topic && category.topic === topic))) context.addIssue({ code: 'custom', message: '默认分类的阅读方向必须保留' });
});
