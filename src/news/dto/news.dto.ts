import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Corpo de criação/edição de notícia.
 *
 * Chega como `multipart/form-data` (por causa da imagem), então todo campo vem
 * como texto — daí o `Transform` no booleano.
 */
export class NewsDto {
  @ApiProperty({
    example: 'Inscrições do Cursilho de Jovens abertas',
    description: 'Título da notícia',
  })
  @IsString()
  @MaxLength(140)
  title: string;

  @ApiProperty({
    example: 'As vagas são limitadas e as inscrições vão até 30 de agosto.',
    description: 'Chamada curta mostrada no feed',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(280)
  summary?: string;

  @ApiProperty({
    example: '<p>Texto completo da notícia</p>',
    description: 'Texto da notícia (HTML do editor)',
  })
  @IsString()
  content: string;

  @ApiProperty({
    example: true,
    description: 'Publicada (aparece no feed) ou rascunho',
  })
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      return value.toLowerCase() === 'true';
    }
    return Boolean(value);
  })
  @IsBoolean()
  isPublished: boolean;

  @ApiProperty({
    example: 'false',
    description:
      'Remove a imagem atual. Vale para o update, quando não vem arquivo novo.',
    required: false,
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      return value.toLowerCase() === 'true';
    }
    return Boolean(value);
  })
  @IsBoolean()
  removeImage?: boolean;

  @ApiProperty({
    description:
      'Restringe o mural a quem está neste evento (inscrito ou na lista de ' +
      'espera). Vazio = aviso geral, visível para todo mundo.',
    required: false,
  })
  @IsOptional()
  // vem do multipart: "" é o "todos" do formulário
  @Transform(({ value }) => (value === '' ? null : value))
  @IsString()
  eventId?: string | null;

  @ApiProperty({
    description:
      'Grupos de inscrição que recebem esta notícia no WhatsApp — a mensagem ' +
      'vai para o grupo apontado pelo link de cada um.',
    required: false,
    type: [String],
  })
  @IsOptional()
  // Vem de `multipart/form-data`: um único destino chega como texto, vários
  // chegam como lista, e o front também pode mandar tudo num JSON.
  @Transform(({ value }) => {
    if (value === undefined || value === null || value === '') return [];
    if (Array.isArray(value)) return value;

    if (typeof value === 'string' && value.trim().startsWith('[')) {
      try {
        return JSON.parse(value);
      } catch {
        return [];
      }
    }

    return [value];
  })
  @IsArray()
  @IsString({ each: true })
  groupRoleIds?: string[];

  /** Preenchido pelo controller a partir do multipart, não vem no body */
  imageFile?: Express.Multer.File;
}
