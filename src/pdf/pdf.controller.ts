import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/decorators/auth.guard';
import { situacaoNaFila } from './fila';

/**
 * A posição de um pedido na fila de PDFs, para a tela mostrar enquanto
 * espera. O código é o que o próprio front sorteou e mandou em
 * `X-Pedido-Pdf`: é imprevisível, e a resposta não diz nada além da posição.
 */
@ApiTags('pdf')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('pdf')
export class PdfController {
  @ApiOperation({ summary: 'Posição de um pedido na fila de PDFs' })
  @Get('fila/:pedido')
  fila(@Param('pedido') pedido: string) {
    return situacaoNaFila(pedido.toLowerCase());
  }
}
