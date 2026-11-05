import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ChurchRequestStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * Os ministérios que pedem. Texto, e não enum no banco, para a lista crescer
 * sem migração; a tela do `ic-front` tem a mesma lista
 * (`src/features/solicitacoes/constants.ts`). "Outro" cobre o que não está aqui.
 */
export const MINISTERIOS = [
  'Louvor',
  'Mídia',
  'Som e iluminação',
  'Infantil',
  'Jovens',
  'Recepção',
  'Intercessão',
  'Ação social',
  'Diaconia',
  'Ensino',
  'Casais',
  'Outro',
] as const;

/** Um produto do pedido */
export class ProdutoDaSolicitacaoDto {
  @ApiProperty({ example: 'Microfone sem fio' })
  @IsString()
  @IsNotEmpty({ message: 'Dê um nome a cada produto' })
  @MaxLength(120)
  nome: string;

  @ApiProperty({ example: 2, minimum: 1, maximum: 999 })
  @IsInt({ message: 'A quantidade é um número inteiro' })
  @Min(1, { message: 'A quantidade mínima é 1' })
  @Max(999)
  quantidade: number;

  @ApiPropertyOptional({ example: 'https://loja.com.br/microfone' })
  @IsOptional()
  @IsUrl(
    { protocols: ['http', 'https'], require_protocol: true },
    { message: 'O link do produto precisa começar com http:// ou https://' },
  )
  @MaxLength(500)
  link?: string;
}

export class CriarSolicitacaoDto {
  @ApiProperty({ enum: MINISTERIOS, example: 'Louvor' })
  @IsIn(MINISTERIOS, { message: 'Escolha o ministério que está pedindo' })
  ministerio: string;

  @ApiProperty({ example: 'Microfones para o culto jovem' })
  @IsString()
  @IsNotEmpty({ message: 'Diga o que está sendo pedido' })
  @MaxLength(120)
  titulo: string;

  @ApiProperty({ example: 'O pedestal do vocal quebrou no culto de domingo.' })
  @IsString()
  @IsNotEmpty({ message: 'Explique o pedido' })
  @MaxLength(2000)
  descricao: string;

  @ApiProperty({ type: [ProdutoDaSolicitacaoDto] })
  @IsArray()
  @ArrayMinSize(1, { message: 'Coloque ao menos um produto' })
  @ArrayMaxSize(20, { message: 'Uma solicitação tem no máximo 20 produtos' })
  @ValidateNested({ each: true })
  @Type(() => ProdutoDaSolicitacaoDto)
  produtos: ProdutoDaSolicitacaoDto[];
}

export class MudarStatusDto {
  @ApiProperty({ enum: ChurchRequestStatus })
  @IsEnum(ChurchRequestStatus, { message: 'Situação inválida' })
  status: ChurchRequestStatus;

  @ApiPropertyOptional({
    description: 'O que o membro lê junto da situação: o motivo, o prazo',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  resposta?: string;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Só em PARTIALLY_ACCEPTED: os ids dos produtos aceitos (alguns, não todos)',
  })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  produtosAceitos?: string[];
}
