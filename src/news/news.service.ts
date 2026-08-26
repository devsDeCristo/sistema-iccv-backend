import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma';
import {
  resolveImageExtension,
  uploadImageFirebase,
} from 'src/utils/uploadImgFirebase';
import { NewsDto } from './dto/news.dto';

/** Campos que o feed do inscrito precisa — sem rascunho e sem dado interno. */
const CAMPOS_DO_FEED = {
  id: true,
  title: true,
  summary: true,
  content: true,
  imageUrl: true,
  publishedAt: true,
  createdAt: true,
  author: { select: { fullName: true } },
};

@Injectable()
export class NewsService {
  constructor(private prisma: PrismaService) {}

  /**
   * Feed do inscrito: só publicadas, da mais recente para a mais antiga.
   *
   * Ordena por `publishedAt` com `createdAt` como desempate — notícia publicada
   * e reeditada não pula para o topo por causa da edição.
   */
  async findPublished(take?: number) {
    return this.prisma.news.findMany({
      where: { isPublished: true },
      select: CAMPOS_DO_FEED,
      orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
      take: take && take > 0 ? take : undefined,
    });
  }

  /** Lista do admin: inclui rascunho, ordenada pela última mexida. */
  async findAll() {
    return this.prisma.news.findMany({
      select: {
        ...CAMPOS_DO_FEED,
        isPublished: true,
        updatedAt: true,
      },
      orderBy: [{ updatedAt: 'desc' }],
    });
  }

  async create(data: NewsDto, authorId?: string) {
    // valida a imagem antes de gravar: subir arquivo de um registro que vai
    // falhar deixa lixo no bucket
    const extensao = data.imageFile
      ? resolveImageExtension(data.imageFile)
      : null;

    const noticia = await this.prisma.news.create({
      data: {
        title: data.title.trim(),
        summary: data.summary?.trim() || null,
        content: data.content,
        isPublished: data.isPublished,
        publishedAt: data.isPublished ? new Date() : null,
        authorId: authorId ?? null,
      },
    });

    if (!data.imageFile) return noticia;

    const { url } = await uploadImageFirebase(
      data.imageFile,
      `news/${noticia.id}/cover.${extensao}`,
    );

    return this.prisma.news.update({
      where: { id: noticia.id },
      data: { imageUrl: url },
    });
  }

  async update(id: string, data: NewsDto) {
    const atual = await this.prisma.news.findUnique({ where: { id } });
    if (!atual) throw new NotFoundException('Notícia não encontrada');

    const extensao = data.imageFile
      ? resolveImageExtension(data.imageFile)
      : null;

    const imageUrl = data.imageFile
      ? (
          await uploadImageFirebase(
            data.imageFile,
            `news/${id}/cover.${extensao}`,
          )
        ).url
      : data.removeImage
      ? null
      : atual.imageUrl;

    return this.prisma.news.update({
      where: { id },
      data: {
        title: data.title.trim(),
        summary: data.summary?.trim() || null,
        content: data.content,
        isPublished: data.isPublished,
        imageUrl,
        // a data de publicação é a da primeira vez: republicar depois de virar
        // rascunho não muda a ordem do feed
        publishedAt:
          data.isPublished && !atual.publishedAt
            ? new Date()
            : atual.publishedAt,
      },
    });
  }

  async remove(id: string) {
    const atual = await this.prisma.news.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!atual) throw new NotFoundException('Notícia não encontrada');

    await this.prisma.news.delete({ where: { id } });
  }
}
