import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

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

  /** Preenchido pelo controller a partir do multipart, não vem no body */
  imageFile?: Express.Multer.File;
}
