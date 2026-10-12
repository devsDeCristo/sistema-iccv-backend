import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ChurchModule } from '@prisma/client';
import {
  ArrayUnique,
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class PlanoDto {
  @ApiProperty({ example: 'Completo' })
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string | null;

  /** Valor mensal, em reais; zero é gratuito */
  @ApiProperty({ example: 149.9 })
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'Valor com no máximo dois decimais' },
  )
  @Min(0, { message: 'O valor não pode ser negativo' })
  @Max(99_999_999.99)
  price: number;

  /** Os módulos que o plano libera; lista vazia não libera nenhum */
  @ApiProperty({ enum: ChurchModule, isArray: true })
  @IsArray()
  @ArrayUnique()
  @IsEnum(ChurchModule, { each: true })
  modules: ChurchModule[];
}
